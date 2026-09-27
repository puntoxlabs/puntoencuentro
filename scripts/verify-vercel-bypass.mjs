/**
 * verify-vercel-bypass.mjs
 *
 * Verifica el estado de Vercel Protection para PuntoEncuentro.
 *
 * Comprueba:
 *   1. staging.puntoencuentro.com.ar → debe ser público (HTTP 200)
 *   2. Una URL de deployment preview real (*.vercel.app) → debe estar
 *      protegida cuando se accede sin bypass (HTTP 302/401/403 hacia SSO Vercel)
 *
 * IMPORTANTE:
 *   - No se rota ni genera ningún secret.
 *   - protectionBypassForAutomation = false en el proyecto; sin secret en repo.
 *   - La URL de preview se puede pasar como argumento o como env VERCEL_PREVIEW_URL.
 *
 * Uso:
 *   node scripts/verify-vercel-bypass.mjs
 *   node scripts/verify-vercel-bypass.mjs https://puntoencuentro-<hash>-<team>.vercel.app
 */

const STAGING_CUSTOM_DOMAIN = 'https://staging.puntoencuentro.com.ar';

// URL de deployment preview: pasar como argumento CLI o variable de entorno.
// No se asume ni inventa una URL; si no se provee, se informa cómo obtenerla.
const previewUrl = process.argv[2] || process.env.VERCEL_PREVIEW_URL;

async function checkUrl(url, expectPublic) {
  const label = expectPublic ? 'PÚBLICO' : 'PROTEGIDO';
  let status = null;
  let redirectLocation = null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',    // No seguir redirecciones para capturar 302 SSO
      headers: {
        'User-Agent': 'PuntoEncuentro/verify-bypass-script',
      },
    });

    status = res.status;
    redirectLocation = res.headers.get('location') || null;
  } catch (err) {
    console.error(`[ERROR] No se pudo conectar a ${url}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const isPublic = status >= 200 && status < 400 && !isVercelProtectedRedirect(status, redirectLocation);
  const isProtected = !isPublic;

  if (expectPublic && isPublic) {
    console.log(`✅ ${label}: ${url} → HTTP ${status} (acceso libre)`);
  } else if (!expectPublic && isProtected) {
    console.log(`✅ ${label}: ${url} → HTTP ${status}${redirectLocation ? ` → ${redirectLocation.slice(0, 60)}…` : ''} (acceso bloqueado sin bypass)`);
  } else if (expectPublic && !isPublic) {
    console.error(`❌ FALLO: ${url} debería ser público pero devolvió HTTP ${status}`);
    process.exitCode = 1;
  } else {
    console.error(`❌ FALLO: ${url} debería estar protegido pero devolvió HTTP ${status} (acceso libre)`);
    process.exitCode = 1;
  }
}

/**
 * Detecta si una respuesta es la redirección de Vercel SSO Protection
 * (redirige a vercel.com/sso o similar).
 */
function isVercelProtectedRedirect(status, location) {
  if (status !== 302 && status !== 301) return false;
  if (!location) return false;
  return (
    location.includes('vercel.com/sso') ||
    location.includes('vercel.com/api/sso') ||
    location.includes('vercel.com/login')
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log('\n🔒 Verificación de Vercel Protection — PuntoEncuentro Staging\n');

// 1. Dominio custom → debe ser público
await checkUrl(STAGING_CUSTOM_DOMAIN, /* expectPublic */ true);

// 2. Deployment preview → debe estar protegido
if (previewUrl) {
  await checkUrl(previewUrl, /* expectPublic */ false);
} else {
  console.warn(`\n⚠️  No se proveyó una URL de deployment preview.`);
  console.warn(`   Pasá la URL como argumento:`);
  console.warn(`   node scripts/verify-vercel-bypass.mjs https://puntoencuentro-<hash>-<equipo>.vercel.app`);
  console.warn(`   O configurá la variable de entorno VERCEL_PREVIEW_URL.`);
  console.warn(`\n   Para obtener la URL más reciente, ejecutá:`);
  console.warn(`   npx vercel ls --token <TOKEN>`);
}

if (!process.exitCode) {
  console.log('\n✅ Verificación completada sin errores.\n');
}
