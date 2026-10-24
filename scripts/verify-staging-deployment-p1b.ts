/**
 * Script de verificación protegida de despliegue en Staging (P1-B).
 *
 * Utiliza el mecanismo autorizado de Vercel Automation Bypass
 * para verificar que https://staging.puntoencuentro.com.ar esté sirviendo
 * efectivamente el bundle compilado de P1-B con HTTP 200, sin exponer
 * secretos ni deshabilitar controles de acceso.
 */

import { getVercelBypassSecret, assertStagingEnvironment, STAGING_PROJECT_REF } from './lib/environment-guard';

const STAGING_URL = 'https://staging.puntoencuentro.com.ar';

async function verifyStagingDeployment(maxAttempts = 12, delayMs = 6000): Promise<boolean> {
  assertStagingEnvironment(STAGING_PROJECT_REF);

  const bypassSecret = getVercelBypassSecret();
  if (!bypassSecret) {
    throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET no está disponible en el entorno ni en .env.local.');
  }

  const headers: Record<string, string> = {
    'x-vercel-protection-bypass': bypassSecret,
    'cache-control': 'no-store',
  };

  const markers = [
    { name: 'Clave cooldown de asistente P1-B', pattern: 'pe_sound_visibility_assistant_dismissed_until_v1' },
    { name: 'Clave conservación de paso P1-B', pattern: 'pe_assistant_saved_step_v1' },
    { name: 'Acceso directo Windows ms-settings:notifications', pattern: 'ms-settings:notifications' },
    { name: 'Clave confirmación de éxito asistente P1-B', pattern: 'assistant_confirm_yes' },
    { name: 'Stepper de 3 pasos de asistente P1-B', pattern: 'pe-assistant-stepper' },
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n[Intento ${attempt}/${maxAttempts}] Consultando ${STAGING_URL} con Vercel Automation Bypass...`);
    const htmlRes = await fetch(STAGING_URL, {
      headers,
      cache: 'no-store',
      redirect: 'manual',
    });

    console.log(`  Respuesta HTTP: ${htmlRes.status} ${htmlRes.statusText}`);
    if (htmlRes.status !== 200) {
      console.warn(`  HTTP ${htmlRes.status}. Esperando actualización de despliegue...`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const htmlText = await htmlRes.text();
    const scriptMatch = htmlText.match(/src="(\/assets\/index-[^"]+\.js)"/);
    if (!scriptMatch) {
      console.warn('  No se encontró script principal en HTML. Esperando...');
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const scriptPath = scriptMatch[1];
    const bundleUrl = `${STAGING_URL}${scriptPath}`;
    console.log(`  Bundle detectado: ${scriptPath}`);

    const bundleRes = await fetch(bundleUrl, {
      headers,
      cache: 'no-store',
    });

    if (bundleRes.status !== 200) {
      console.warn(`  HTTP ${bundleRes.status} al descargar bundle. Esperando...`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const bundleText = await bundleRes.text();
    console.log(`  Tamaño del bundle remoto descargado: ${(bundleText.length / 1024).toFixed(1)} KB`);

    let missingCount = 0;
    for (const marker of markers) {
      const present = bundleText.includes(marker.pattern);
      console.log(`  - ${marker.name}: ${present ? 'PRESENTE (OK)' : 'NO ENCONTRADO'}`);
      if (!present) missingCount++;
    }

    if (missingCount === 0) {
      console.log('\n==========================================================');
      console.log('✅ Despliegue de Staging P1-B verificado con éxito');
      console.log(`URL: ${STAGING_URL}`);
      console.log(`Bundle: ${scriptPath}`);
      console.log('Todos los marcadores de P1-B fueron validados activamente.');
      console.log('==========================================================\n');
      return true;
    }

    if (attempt < maxAttempts) {
      console.log(`  ${missingCount} marcador(es) pendientes. Esperando a que Vercel finalice el despliegue (${delayMs / 1000}s)...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.error('\n[TIMEOUT] Se agotaron los intentos de verificación sin detectar todos los marcadores.');
  return false;
}

verifyStagingDeployment()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((err) => {
    console.error('Error fatal durante la verificación de Staging:', err.message);
    process.exit(1);
  });
