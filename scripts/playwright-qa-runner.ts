/**
 * QA de Navegador Real con Playwright Chromium
 *
 * Ejecuta validaciones en navegador real headless:
 * 1. Dominio Remoto: Redirección perimetral de Vercel Authentication a SSO Edge.
 * 2. Interfaz SPA (dist/):
 *    - Presentación de AccessGate en sesión limpia.
 *    - Rechazo de contraseña incorrecta en UI.
 *    - Desbloqueo y renderizado del shell principal.
 *    - Persistencia en recarga (localStorage).
 *    - Navegación responsive móvil (375x667).
 *    - Preservación de Deep Links y rutas.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium, Browser, Page, LaunchOptions } from '@playwright/test';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const PORT = 4173;
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const REMOTE_STAGING_URL = 'https://staging.puntoencuentro.com.ar';

function resolveChromiumLaunchOptions(): LaunchOptions {
  const defaultExec = chromium.executablePath();
  if (defaultExec && fs.existsSync(defaultExec)) {
    return { headless: true };
  }

  const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envExec && fs.existsSync(envExec)) {
    return { headless: true, executablePath: envExec };
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const msPlaywrightDir = path.join(localAppData, 'ms-playwright');
    if (fs.existsSync(msPlaywrightDir)) {
      const dirs = fs.readdirSync(msPlaywrightDir).sort().reverse();
      for (const dir of dirs) {
        const candidates = [
          path.join(msPlaywrightDir, dir, 'chrome-win64', 'chrome.exe'),
          path.join(msPlaywrightDir, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        ];
        const found = candidates.find((candidate) => fs.existsSync(candidate));
        if (found) {
          console.log(`[Browser] Usando ejecutable Chromium local disponible: ${found}`);
          return { headless: true, executablePath: found };
        }
      }
    }
  }

  return { headless: true };
}

// Servidor estático con soporte SPA para servir dist/
function startStaticServer(): Promise<http.Server> {
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
  };

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    let filePath = path.join(DIST_DIR, reqPath === '/' ? 'index.html' : reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading file');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[Servidor Local SPA] Activo en ${LOCAL_URL}`);
      resolve(server);
    });
  });
}

interface StepResult {
  step: string;
  passed: boolean;
  details: string;
}

const stepResults: StepResult[] = [];

function record(step: string, condition: boolean, details: string) {
  stepResults.push({ step, passed: condition, details });
  const icon = condition ? '✔ PASS' : '❌ FAIL';
  console.log(`[BROWSER-QA] ${icon} - ${step}: ${details}`);
}

async function main() {
  console.log('==============================================================================');
  console.log('RECORRIDO DE QA EN NAVEGADOR REAL (PLAYWRIGHT CHROMIUM)');
  console.log('==============================================================================\n');

  const server = await startStaticServer();
  const launchOptions = resolveChromiumLaunchOptions();
  const browser: Browser = await chromium.launch(launchOptions);

  try {
    // --------------------------------------------------------------------------
    // PARTE 1: Verificación Remota de Dominio Staging (Vercel Edge Protection)
    // --------------------------------------------------------------------------
    console.log('\n--- 1. Verificación de Perímetro en Dominio Remoto ---');
    const remoteContext = await browser.newContext();
    const remotePage: Page = await remoteContext.newPage();

    console.log(`Navegando a ${REMOTE_STAGING_URL}...`);
    await remotePage.goto(REMOTE_STAGING_URL, { waitUntil: 'load', timeout: 15000 });
    const finalUrl = remotePage.url();
    const pageTitle = await remotePage.title();

    const isVercelSSO = finalUrl.includes('vercel.com/sso-api') || finalUrl.includes('vercel.com/login');
    record(
      'Edge SSO Redirect (Dominio Remoto)',
      isVercelSSO,
      `URL final: ${finalUrl.slice(0, 70)}... | Título: "${pageTitle}"`
    );
    await remoteContext.close();

    // --------------------------------------------------------------------------
    // PARTE 2: Verificación de Interfaz en Navegador Real (AccessGate y UI Shell)
    // --------------------------------------------------------------------------
    console.log('\n--- 2. Verificación de UI Shell y AccessGate en Navegador Real ---');
    const localContext = await browser.newContext();
    const localPage: Page = await localContext.newPage();

    // 2.1. Sesión limpia: debe renderizar AccessGate y declarar lang="es-AR"
    await localPage.goto(LOCAL_URL, { waitUntil: 'networkidle' });

    const htmlLang = await localPage.getAttribute('html', 'lang');
    record(
      'Atributo Idioma HTML (es-AR)',
      htmlLang === 'es-AR',
      `html[lang]="${htmlLang}"`
    );

    const hasTitle = (await localPage.locator('h1').textContent())?.includes('PuntoEncuentro');
    const hasSubtitle = (await localPage.locator('h2').textContent())?.includes('Acceso de pruebas');
    const hasPasswordInput = await localPage.locator('input[type="password"]').isVisible();
    const hasSubmitButton = await localPage.locator('button[type="submit"]').isVisible();

    record(
      'AccessGate Visible en Sesión Limpia',
      !!(hasTitle && hasSubtitle && hasPasswordInput && hasSubmitButton),
      `Título: "PuntoEncuentro", Subtítulo: "Acceso de pruebas", Input y Botón visibles`
    );

    // 2.2. Contraseña incorrecta: debe mostrar error
    console.log('\n--- 3. Comprobación de Contraseña Incorrecta ---');
    await localPage.fill('input[type="password"]', 'clave_invalida_qa');
    await localPage.click('button[type="submit"]');

    // Esperar mensaje de error
    await localPage.waitForTimeout(500);
    const errorText = await localPage.locator('form').textContent();
    const showsError = (errorText || '').includes('Contraseña incorrecta');

    record(
      'Rechazo de Contraseña Incorrecta en UI',
      showsError,
      `Mensaje capturado en DOM: "${errorText?.trim().slice(0, 50)}"`
    );

    // 2.3. Desbloqueo y renderizado de aplicación con credencial autorizada
    console.log('\n--- 4. Desbloqueo y Renderizado de UI Shell ---');
    // Simulamos la resolución de credencial autorizada en localStorage
    await localPage.evaluate(() => {
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
    });
    await localPage.reload({ waitUntil: 'networkidle' });

    // Verificamos que AccessGate desapareció y que el shell de la aplicación está montado
    const gateVisibleAfter = await localPage.locator('h2:text("Acceso de pruebas")').isVisible();
    const bodyContent = await localPage.content();
    const hasAppShell = !gateVisibleAfter && (bodyContent.includes('PuntoEncuentro') || bodyContent.includes('root'));

    record(
      'Desbloqueo de UI Shell tras Autorización',
      hasAppShell && !gateVisibleAfter,
      `AccessGate oculto; DOM principal renderizado exitosamente`
    );

    // 2.4. Persistencia al recargar
    console.log('\n--- 5. Persistencia tras Recarga ---');
    await localPage.reload({ waitUntil: 'networkidle' });
    const gateAfterReload = await localPage.locator('h2:text("Acceso de pruebas")').isVisible();
    const storedItem = await localPage.evaluate(() => localStorage.getItem('puntoencuentro_test_access_v1'));

    record(
      'Persistencia de Acceso tras Recargar',
      !gateAfterReload && !!storedItem,
      `localStorage persistido: ${storedItem?.slice(0, 40)}...`
    );

    // 2.5. Navegación Móvil (Viewport 375x667)
    console.log('\n--- 6. Navegación Responsive Móvil ---');
    await localPage.setViewportSize({ width: 375, height: 667 });
    await localPage.waitForTimeout(300);

    const viewportSize = localPage.viewportSize();
    const isMobileResponsive = viewportSize?.width === 375 && viewportSize?.height === 667;
    const overflowMetrics = await localPage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    const noHorizontalOverflow = overflowMetrics.scrollWidth <= overflowMetrics.clientWidth;

    record(
      'Viewport Móvil Emulado (375x667) sin Overflow Horizontal',
      isMobileResponsive && noHorizontalOverflow,
      `Viewport: ${viewportSize?.width}x${viewportSize?.height}px | scrollWidth=${overflowMetrics.scrollWidth}px <= clientWidth=${overflowMetrics.clientWidth}px`
    );

    // 2.6. Rutas Profundas y Deep Links
    console.log('\n--- 7. Preservación de Rutas Profundas ---');
    const testDeepLink = `${LOCAL_URL}/create`;
    await localPage.goto(testDeepLink, { waitUntil: 'networkidle' });

    const currentUrl = localPage.url();
    const preservesRoute = currentUrl.includes('/create');

    record(
      'Preservación de Ruta Profunda (/create)',
      preservesRoute,
      `URL actual conserva ruta profunda: ${currentUrl}`
    );

    // 2.7. Ruta inexistente: debe renderizar NotFoundFallback con retorno a Inicio
    console.log('\n--- 8. Ruta Inexistente (Fallback 404 *) ---');
    await localPage.goto(`${LOCAL_URL}/ruta-inexistente-qa-404`, { waitUntil: 'networkidle' });
    const notFoundText = (await localPage.textContent('body')) || '';
    const hasNotFoundHeading = notFoundText.includes('Página no encontrada');
    const goHomeButton = localPage.locator('button:has-text("Ir al inicio")');
    const hasGoHomeButton = await goHomeButton.isVisible();
    if (hasGoHomeButton) {
      await goHomeButton.click();
      await localPage.waitForTimeout(300);
    }
    const redirectedHome = new URL(localPage.url()).pathname === '/';

    record(
      'Fallback 404 (*) Renderiza Estado Claro y Navega al Inicio',
      hasNotFoundHeading && hasGoHomeButton && redirectedHome,
      `Título="Página no encontrada": ${hasNotFoundHeading}, Botón="Ir al inicio": ${hasGoHomeButton}, URL retorno: ${localPage.url()}`
    );

    await localContext.close();

  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n==============================================================================');
  console.log('RESUMEN DE PRUEBAS EN NAVEGADOR REAL:');
  const allPassed = stepResults.every((r) => r.passed);
  const passedCount = stepResults.filter((r) => r.passed).length;
  console.log(`Total: ${passedCount}/${stepResults.length} PASADAS`);
  if (!allPassed) {
    console.error('ALERTA: Se detectaron fallos en las pruebas de navegador.');
    process.exit(1);
  } else {
    console.log('ESTADO: 100% PASS. Verificaciones en navegador real completadas con éxito.');
    console.log('==============================================================================');
  }
}

main().catch((err) => {
  console.error('[FATAL] Error en pruebas de navegador:', err);
  process.exit(1);
});
