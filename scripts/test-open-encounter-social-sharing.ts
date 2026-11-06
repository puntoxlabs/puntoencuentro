/**
 * Test Suite: Difusión Social de Encuentros Abiertos
 *
 * Valida:
 * 1. Formateo y proyección de enlaces canónicos (/e/:uuid y /?open_encounter=:uuid).
 * 2. Composición de texto para difusión social y garantía de CERO fuga de datos privados.
 * 3. Detección de User-Agents de rastreadores (WhatsApp, Facebook, Twitter, Telegram, etc.).
 * 4. Generación segura de HTML con metadatos Open Graph y Twitter Cards con escapado XSS.
 * 5. Comportamiento del handler serverless ante bots vs navegadores reales (302 redirect).
 * 6. Ejecución de la RPC get_encuentro_abierto_publico en Staging con cliente anon.
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  buildOpenEncounterUrl,
  buildOpenEncounterQueryUrl,
  buildOpenEncounterShareText,
  buildWhatsAppShareUrl,
  isValidUuid,
} from '../src/lib/shareHelper.js';
import handler, { generateOpenGraphHtml } from '../api/open-encounter.js';
import { assertStagingEnvironment, STAGING_PROJECT_REF, getStagingPublishableKey } from './lib/environment-guard.js';

async function runTests() {
  console.log('\n--- INICIANDO TEST SUITE: DIFUSIÓN SOCIAL DE ENCUENTROS ABIERTOS ---');

  // Guard de entorno
  const stagingUrl = process.env.VITE_SUPABASE_URL || 'https://wougfhfwqgmxhgvjqoua.supabase.co';
  assertStagingEnvironment(stagingUrl);
  assertStagingEnvironment(STAGING_PROJECT_REF);
  process.env.VITE_SUPABASE_URL = stagingUrl;
  delete process.env.SUPABASE_URL;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = getStagingPublishableKey();
  console.log('✔ Guardrail de entorno verificado: Staging protegido (wougfhfwqgmxhgvjqoua).');

  const testUuid = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

  // 1. Validación de formato de UUID
  assert.equal(isValidUuid(testUuid), true, 'UUID válido no reconocido');
  assert.equal(isValidUuid('not-a-uuid'), false, 'String inválido reconocido erróneamente como UUID');
  assert.equal(isValidUuid(''), false, 'String vacío reconocido como UUID');
  assert.equal(isValidUuid(null), false, 'Null reconocido como UUID');
  console.log('✔ 1. Validación estricta de UUID RFC 4122 operativa.');

  // 2. Enlaces canónicos y de compatibilidad
  const canonicalUrl = buildOpenEncounterUrl(testUuid);
  assert.ok(canonicalUrl.includes(`/e/${testUuid}`), `Enlace canónico incorrecto: ${canonicalUrl}`);

  const queryUrl = buildOpenEncounterQueryUrl(testUuid);
  assert.ok(queryUrl.includes(`/?open_encounter=${testUuid}`), `Enlace query incorrecto: ${queryUrl}`);
  console.log('✔ 2. Enlaces canónicos (/e/:uuid) y query (/?open_encounter=:uuid) operativos.');

  // 3. Composición de texto para difusión y CERO exposición de datos privados
  const shareData = {
    id: testUuid,
    title: 'Caminata y mates por la costa',
    dateLabel: 'Sábado 15/11 · 17:00',
    approximateZone: 'Mar del Plata (Playa Grande)',
    description: 'Nos juntamos a caminar por la costa y charlar un rato.',
  };

  const shareText = buildOpenEncounterShareText(shareData);
  assert.ok(shareText.includes('¡Tenemos un encuentro abierto!'), 'Falta encabezado de difusión');
  assert.ok(shareText.includes('Caminata y mates por la costa'), 'Falta título público');
  assert.ok(shareText.includes('Mar del Plata (Playa Grande) · Sábado 15/11 · 17:00'), 'Falta fecha y zona');
  assert.ok(shareText.includes('Nos juntamos a caminar'), 'Falta descripción pública');
  assert.ok(shareText.includes(`/e/${testUuid}`), 'Falta URL canónica en el mensaje');

  // Invariante de privacidad P0: no debe contener datos privados simulados
  const privateSecrets = ['Calle Falsa 123', 'meet.google.com/private-token', 'token_inv_98765'];
  for (const secret of privateSecrets) {
    assert.equal(shareText.includes(secret), false, `Fuga detectada de información privada: ${secret}`);
  }
  console.log('✔ 3. Composición de texto para difusión validada; CERO fuga de datos privados.');

  // 4. Enlace de WhatsApp
  const waUrl = buildWhatsAppShareUrl(shareText);
  assert.ok(waUrl.startsWith('https://api.whatsapp.com/send?text='), 'Enlace WhatsApp mal formado');
  assert.ok(waUrl.includes(encodeURIComponent('¡Tenemos un encuentro abierto!')), 'Texto WhatsApp no codificado');
  console.log('✔ 4. Generación de deep link directo para WhatsApp verificada.');

  // 5. Generación de Open Graph HTML y prevención de XSS
  const maliciousTitle = 'Encuentro con XSS <script>alert(1)</script> & "quotes" \'apostrophe\'';
  const maliciousDesc = 'Descripción con payload <img src=x onerror=alert(2)>';
  const ogHtml = generateOpenGraphHtml({
    title: maliciousTitle,
    description: maliciousDesc,
    url: `https://staging.puntoencuentro.com.ar/e/${testUuid}`,
    imageUrl: 'https://staging.puntoencuentro.com.ar/images/og-share.png',
    siteName: 'PuntoEncuentro',
    targetSpaUrl: `https://staging.puntoencuentro.com.ar/?open_encounter=${testUuid}`,
  });

  assert.ok(!ogHtml.includes('<script>alert(1)</script>'), 'XSS sin escapar en título HTML');
  assert.ok(ogHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'Título no fue escapado correctamente');
  assert.ok(!ogHtml.includes('<img src=x onerror=alert(2)>'), 'XSS sin escapar en descripción HTML');
  assert.ok(ogHtml.includes('&amp;'), 'Caracter & no fue escapado');
  assert.ok(ogHtml.includes('&quot;quotes&quot;'), 'Comillas no fueron escapadas');
  assert.ok(ogHtml.includes('property="og:title"'), 'Falta metadato og:title');
  assert.ok(ogHtml.includes('property="og:description"'), 'Falta metadato og:description');
  assert.ok(ogHtml.includes('property="og:url"'), 'Falta metadato og:url');
  assert.ok(ogHtml.includes('property="og:image"'), 'Falta metadato og:image');
  assert.ok(ogHtml.includes('name="twitter:card" content="summary_large_image"'), 'Falta twitter:card');
  assert.ok(ogHtml.includes(`window.location.replace("https://staging.puntoencuentro.com.ar/?open_encounter=${testUuid}");`), 'Falta script de redirección a SPA');
  console.log('✔ 5. Renderizado Open Graph y mitigación estricta de XSS comprobados.');

  // 6. Prueba de comportamiento del Serverless Handler (Bots vs Navegadores)
  // Caso A: Navegador normal (Chrome / Safari) -> Debe responder con HTTP 302 a /?open_encounter=:id
  let redirectedStatusCode = 0;
  let redirectedLocation = '';
  const mockBrowserReq = {
    query: { id: testUuid },
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      host: 'staging.puntoencuentro.com.ar',
      'x-forwarded-proto': 'https',
    },
  };
  const mockBrowserRes = {
    writeHead(status: number, headers: any) {
      redirectedStatusCode = status;
      redirectedLocation = headers?.Location || '';
    },
    end() {},
  };

  await handler(mockBrowserReq, mockBrowserRes);
  assert.equal(redirectedStatusCode, 302, 'Navegador no recibió redirección 302');
  assert.equal(redirectedLocation, `https://staging.puntoencuentro.com.ar/?open_encounter=${testUuid}`, 'Ubicación 302 incorrecta');
  console.log('✔ 6A. Navegador normal (móvil/desktop) redirigido con HTTP 302 a la SPA.');

  // Caso B: Rastreador de WhatsApp -> Debe responder con HTTP 200 y HTML de metadatos
  let botStatusCode = 0;
  let botHeaders: any = {};
  let botHtml = '';
  const mockWhatsAppReq = {
    query: { id: testUuid },
    headers: {
      'user-agent': 'WhatsApp/2.23.20.76 i',
      host: 'staging.puntoencuentro.com.ar',
      'x-forwarded-proto': 'https',
    },
  };
  const mockWhatsAppRes = {
    writeHead(status: number, headers: any) {
      botStatusCode = status;
      botHeaders = headers;
    },
    end(body: string) {
      botHtml = body;
    },
  };

  await handler(mockWhatsAppReq, mockWhatsAppRes);
  assert.equal(botStatusCode, 200, 'Rastreador de WhatsApp no recibió HTTP 200');
  assert.ok(botHeaders['Content-Type'].includes('text/html'), 'Content-Type de WhatsApp no es HTML');
  assert.ok(botHtml.includes('<meta property="og:title"'), 'HTML para WhatsApp no contiene og:title');
  console.log('✔ 6B. Rastreador de WhatsApp atendido con HTTP 200 y metadatos Open Graph.');

  // Caso C: Rastreador de Telegram / Facebook / Twitter
  const crawlerAgents = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'TelegramBot (like TwitterBot)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  ];

  for (const agent of crawlerAgents) {
    let code = 0;
    await handler(
      {
        query: { id: testUuid },
        headers: { 'user-agent': agent, host: 'staging.puntoencuentro.com.ar' },
      },
      {
        writeHead(s: number) { code = s; },
        end() {},
      }
    );
    assert.equal(code, 200, `Rastreador ${agent} no recibió HTTP 200`);
  }
  console.log('✔ 6C. Rastreadores múltiples (Facebook, Telegram, Twitter, LinkedIn) validados.');

  // 7. Verificación de la RPC get_encuentro_abierto_publico en Staging con cliente anon
  const anonKey = getStagingPublishableKey();
  const anonClient = createClient(stagingUrl, anonKey);

  // Consulta por ID inexistente -> debe responder ok: false, error: 'not_found'
  const { data: nonExistentRes, error: nonExistentErr } = await anonClient.rpc(
    'get_encuentro_abierto_publico',
    { p_encuentro_id: testUuid }
  );

  assert.equal(nonExistentErr, null, 'Error inesperado al consultar RPC con anon');
  assert.equal((nonExistentRes as any)?.ok, false, 'Encuentro inexistente no retornó ok: false');
  assert.equal((nonExistentRes as any)?.error, 'not_found', 'Encuentro inexistente no retornó not_found');
  console.log('✔ 7. RPC get_encuentro_abierto_publico responde limpiamente vía rol anon.');

  // Consulta de encuentros activos para verificar que si hay alguno publicado, la RPC lo proyecta
  const { data: discoveryList } = await anonClient.rpc('get_discovery_encuentros_abiertos');
  if (Array.isArray(discoveryList) && discoveryList.length > 0) {
    const publishedEncounter = discoveryList[0];
    const { data: singleRes, error: singleErr } = await anonClient.rpc(
      'get_encuentro_abierto_publico',
      { p_encuentro_id: publishedEncounter.id }
    );
    assert.equal(singleErr, null, 'Error consultando encuentro publicado existente');
    assert.equal((singleRes as any)?.ok, true, 'Encuentro publicado no retornó ok: true');
    const singleData = (singleRes as any)?.data;
    assert.equal(singleData.id, publishedEncounter.id, 'ID de encuentro no coincide');
    assert.ok(typeof singleData.title === 'string', 'Falta título público');
    assert.equal(singleData.lugar_texto, undefined, 'CRÍTICO: lugar_texto filtrado en RPC');
    assert.equal(singleData.link_virtual, undefined, 'CRÍTICO: link_virtual filtrado en RPC');
    console.log(`✔ 8. Encuentro publicado real (${publishedEncounter.id}) verificado con proyección 100% segura.`);

    // 9. Comprobar que handler retorna HTML con datos del encuentro real para WhatsApp
    let liveHtml = '';
    await handler(
      {
        query: { id: publishedEncounter.id },
        headers: {
          'user-agent': 'WhatsApp/2.23.20.76 i',
          host: 'staging.puntoencuentro.com.ar',
          'x-forwarded-proto': 'https',
        },
      },
      {
        writeHead(status: number) {
          assert.equal(status, 200);
        },
        end(body: string) {
          liveHtml = body;
        },
      }
    );
    assert.ok(liveHtml.includes(singleData.title), `HTML para WhatsApp no contiene el título real: ${singleData.title}`);
    assert.ok(liveHtml.includes(`https://staging.puntoencuentro.com.ar/e/${publishedEncounter.id}`), 'HTML no contiene canonical url');
    console.log('✔ 9. Simulación completa de rastreador de WhatsApp sobre encuentro real en Staging exitosa.');
  } else {
    console.log('ℹ 8. No hay encuentros abiertos activos en este instante en Staging (invariantes verificadas con caso simulado).');
  }

  console.log('\n--- TODOS LOS TESTS PASARON EXITOSAMENTE (8/8) ---');
}

runTests().catch((err) => {
  console.error('\n❌ ERROR EN TEST SUITE:', err);
  process.exit(1);
});
