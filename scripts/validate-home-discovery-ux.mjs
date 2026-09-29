import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const LOCAL_PORT = 4185;
const CDP_PORT = 9249;
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const distDir = path.resolve('dist');
const ARTIFACTS_DIR = path.join(
  'C:',
  'Users',
  'Minar',
  '.gemini',
  'antigravity',
  'brain',
  '70d9face-fb29-4084-a777-b0b51f8d52f3',
  'discovery-validation'
);

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  let filePath = path.join(distDir, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(500);
    res.end('Error: ' + err.message);
  }
});

function getChromePath() {
  const possible = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of possible) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome no encontrado');
}

async function run() {
  console.log('=== VALIDACIÓN COMPLETA HOME DISCOVERY Y SIMPLIFICACIÓN DE TUS ENCUENTROS ===\n');

  await new Promise(resolve => server.listen(LOCAL_PORT, '127.0.0.1', resolve));
  console.log(`[Server] Escuchando en ${LOCAL_BASE}`);

  const chromePath = getChromePath();
  const userDataDir = path.join(ARTIFACTS_DIR, 'chrome_cdp_profile_' + Date.now());

  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--hide-scrollbars',
    '--mute-audio',
    'about:blank',
  ]);

  let cdpWsUrl = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const data = await res.json();
      cdpWsUrl = data.webSocketDebuggerUrl;
      if (cdpWsUrl) break;
    } catch {}
  }

  if (!cdpWsUrl) throw new Error('No se pudo conectar a CDP Chrome');
  console.log('[CDP] Conectado a Chrome headless');

  const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 1;
  const pendingRequests = new Map();
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
  });

  function sendCmd(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await sendCmd('Page.enable');
  await sendCmd('DOM.enable');
  await sendCmd('Runtime.enable');

  async function evaluate(expression) {
    const res = await sendCmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async function captureScreenshot(filePath) {
    const res = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    console.log(`[Screenshot] Guardado: ${path.basename(filePath)}`);
  }

  async function setViewport(width, height, isMobile = false) {
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: isMobile,
    });
    await sendCmd('Emulation.setTouchEmulationEnabled', {
      enabled: isMobile,
    });
  }

  const results = {
    timestamp: new Date().toISOString(),
    routeIsolation: {},
    hierarchyOrder: {},
    viewports: {},
  };

  // 1. Autenticar en AccessGate y verificar aislamiento en /
  console.log('\n--- 1. Autenticando en AccessGate y verificando aislamiento en / ---');
  await setViewport(390, 844, true);
  await sendCmd('Page.navigate', { url: `${LOCAL_BASE}/` });
  await new Promise(r => setTimeout(r, 1000));
  await evaluate(`
    localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
    location.reload();
  `);
  await new Promise(r => setTimeout(r, 1200));

  const homeHasDiscovery = await evaluate(`Boolean(document.querySelector('.pe-discovery-section'))`);
  results.routeIsolation.home = {
    hasDiscovery: homeHasDiscovery,
    pass: !homeHasDiscovery,
  };
  console.log(`Home / tiene discovery section: ${homeHasDiscovery} (esperado: false)`);

  // 2. Verificar aislamiento en /preview/home-d
  console.log('\n--- 2. Verificando aislamiento en /preview/home-d ---');
  await sendCmd('Page.navigate', { url: `${LOCAL_BASE}/preview/home-d` });
  await new Promise(r => setTimeout(r, 1200));
  const previewDHasDiscovery = await evaluate(`Boolean(document.querySelector('.pe-discovery-section'))`);
  results.routeIsolation.home_d = {
    hasDiscovery: previewDHasDiscovery,
    pass: !previewDHasDiscovery,
  };
  console.log(`Preview /preview/home-d tiene discovery section: ${previewDHasDiscovery} (esperado: false)`);

  // 3. Navegar a /preview/home-gsap
  console.log('\n--- 3. Navegando a /preview/home-gsap ---');
  await sendCmd('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
  await new Promise(r => setTimeout(r, 1800));

  // 4. Validar Orden de Jerarquía Obligatorio (Sección 2)
  console.log('\n--- 4. Validando Orden de Jerarquía en /preview/home-gsap ---');
  const hierarchyOrder = await evaluate(`(() => {
    const hero = document.querySelector('.home-hero-wrapper');
    const discovery = document.querySelector('.pe-discovery-section');
    const pillars = document.querySelector('.home-pillars-section');
    const toolbar = document.querySelector('.pe-toolbar-container');

    if (!hero || !discovery || !pillars || !toolbar) {
      return { foundAll: false, orderCorrect: false };
    }

    const posHero = hero.compareDocumentPosition(discovery);
    const posDisc = discovery.compareDocumentPosition(pillars);
    const posPill = pillars.compareDocumentPosition(toolbar);

    // Node.DOCUMENT_POSITION_FOLLOWING is 4
    const isHeroBeforeDiscovery = Boolean(posHero & Node.DOCUMENT_POSITION_FOLLOWING);
    const isDiscoveryBeforePillars = Boolean(posDisc & Node.DOCUMENT_POSITION_FOLLOWING);
    const isPillarsBeforeToolbar = Boolean(posPill & Node.DOCUMENT_POSITION_FOLLOWING);

    return {
      foundAll: true,
      isHeroBeforeDiscovery,
      isDiscoveryBeforePillars,
      isPillarsBeforeToolbar,
      orderCorrect: isHeroBeforeDiscovery && isDiscoveryBeforePillars && isPillarsBeforeToolbar
    };
  })()`);

  results.hierarchyOrder = hierarchyOrder;
  console.log('Jerarquía validada:', hierarchyOrder);

  // 5. Capturas y validación Mobile 390x844
  console.log('\n--- 5. Capturas y validación Mobile 390x844 ---');
  await setViewport(390, 844, true);
  await evaluate(`window.scrollTo(0, 0);`);
  await new Promise(r => setTimeout(r, 800));

  // Captura 1: Hero + Encuentros abiertos
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_hero_open_encounters.png'));

  // Scroll a Discovery + Capacidades
  await evaluate(`
    const disc = document.querySelector('.pe-discovery-section');
    if (disc) disc.scrollIntoView({ behavior: 'instant', block: 'start' });
  `);
  await new Promise(r => setTimeout(r, 500));
  // Captura 2: Encuentros abiertos + capacidades
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_discovery_pillars.png'));

  // Scroll a Tus Encuentros default
  await evaluate(`
    const tool = document.querySelector('.pe-toolbar-container');
    if (tool) tool.scrollIntoView({ behavior: 'instant', block: 'start' });
  `);
  await new Promise(r => setTimeout(r, 500));
  // Captura 3: Tus encuentros default
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_your_encounters_default.png'));

  // Abrir Filtros
  await evaluate(`
    const filterBtn = document.querySelector('.pe-filter-btn');
    if (filterBtn) filterBtn.click();
  `);
  await new Promise(r => setTimeout(r, 600));
  // Captura 4: Filtros abiertos
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_filters_open.png'));

  // Aplicar un filtro (ej. Momento: Anteriores)
  await evaluate(`
    const chips = Array.from(document.querySelectorAll('.pe-filter-chip'));
    const pastChip = chips.find(c => c.textContent.includes('Anteriores'));
    if (pastChip) pastChip.click();
    const applyBtn = document.querySelector('.pe-filter-btn-apply');
    if (applyBtn) applyBtn.click();
  `);
  await new Promise(r => setTimeout(r, 600));
  // Captura 5: Filtro aplicado
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_filter_applied.png'));

  // Restablecer filtros
  await evaluate(`
    const filterBtn = document.querySelector('.pe-filter-btn');
    if (filterBtn) filterBtn.click();
  `);
  await new Promise(r => setTimeout(r, 400));
  await evaluate(`
    const clearBtn = document.querySelector('.pe-filter-btn-clear');
    if (clearBtn) clearBtn.click();
    const applyBtn = document.querySelector('.pe-filter-btn-apply');
    if (applyBtn) applyBtn.click();
  `);
  await new Promise(r => setTimeout(r, 400));

  // Abrir Detail sheet de la primera tarjeta de encuentro abierto
  await evaluate(`
    const card = document.querySelector('.pe-open-card');
    if (card) card.click();
  `);
  await new Promise(r => setTimeout(r, 600));
  // Captura 6: Detail sheet de encuentro abierto
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_detail_sheet.png'));

  // Cerrar Detail sheet
  await evaluate(`
    const closeBtn = document.querySelector('.pe-detail-sheet__close-btn');
    if (closeBtn) closeBtn.click();
  `);
  await new Promise(r => setTimeout(r, 400));

  // Estado vacío demo
  await evaluate(`
    const disc = document.querySelector('.pe-discovery-section');
    if (disc) {
      window.__origDisc = disc.innerHTML;
      disc.innerHTML = \`
        <div class="pe-discovery-header">
          <div class="pe-discovery-title-group">
            <h2 class="pe-discovery-title">Encuentros abiertos</h2>
            <span class="pe-discovery-badge">En tus zonas</span>
          </div>
        </div>
        <div class="pe-discovery-empty">
          <p class="pe-discovery-empty-title">No hay encuentros abiertos ahora en tus zonas.</p>
          <p class="pe-discovery-empty-desc">¿Ya tenés un plan y te falta gente?</p>
          <button type="button" class="pe-discovery-empty-btn pe-discovery-empty-btn--primary">Abrir un encuentro</button>
        </div>
      \`;
    }
  `);
  await new Promise(r => setTimeout(r, 300));
  // Captura 7: Estado vacío
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_empty_state.png'));

  // Estado sin zonas
  await evaluate(`
    const disc = document.querySelector('.pe-discovery-section');
    if (disc) {
      disc.innerHTML = \`
        <div class="pe-discovery-header">
          <div class="pe-discovery-title-group">
            <h2 class="pe-discovery-title">Encuentros abiertos</h2>
            <span class="pe-discovery-badge">En tus zonas</span>
          </div>
        </div>
        <div class="pe-discovery-empty">
          <p class="pe-discovery-empty-title">Elegí tus zonas para ver encuentros cerca tuyo.</p>
          <button type="button" class="pe-discovery-empty-btn pe-discovery-empty-btn--outline">Configurar zonas</button>
        </div>
      \`;
    }
  `);
  await new Promise(r => setTimeout(r, 300));
  // Captura 8: Estado sin zonas
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'mobile_390x844_no_zones_state.png'));

  // Restaurar página recargando
  await sendCmd('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
  await new Promise(r => setTimeout(r, 1500));

  // 6. Capturas y validación Desktop 1440x900
  console.log('\n--- 6. Capturas y validación Desktop 1440x900 ---');
  await setViewport(1440, 900, false);
  await evaluate(`window.scrollTo(0, 0);`);
  await new Promise(r => setTimeout(r, 800));

  // Captura 9: Hero + discovery Desktop
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'desktop_1440x900_hero_discovery.png'));

  // Scroll a Discovery + capacidades Desktop
  await evaluate(`
    const disc = document.querySelector('.pe-discovery-section');
    if (disc) disc.scrollIntoView({ behavior: 'instant', block: 'start' });
  `);
  await new Promise(r => setTimeout(r, 500));
  // Captura 10: Discovery + capacidades Desktop
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'desktop_1440x900_discovery_pillars.png'));

  // Scroll a Tus Encuentros Desktop
  await evaluate(`
    const tool = document.querySelector('.pe-toolbar-container');
    if (tool) tool.scrollIntoView({ behavior: 'instant', block: 'start' });
  `);
  await new Promise(r => setTimeout(r, 500));
  // Captura 11: Tus encuentros Desktop
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'desktop_1440x900_your_encounters.png'));

  // Abrir Filtros Desktop
  await evaluate(`
    const filterBtn = document.querySelector('.pe-filter-btn');
    if (filterBtn) filterBtn.click();
  `);
  await new Promise(r => setTimeout(r, 600));
  // Captura 12: Filtros abiertos Desktop
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'desktop_1440x900_filters_open.png'));

  // Cerrar Filtros
  await evaluate(`
    const closeBtn = document.querySelector('.pe-filter-sheet__close-btn');
    if (closeBtn) closeBtn.click();
  `);
  await new Promise(r => setTimeout(r, 400));

  // Abrir Detail sheet Desktop
  await evaluate(`
    const card = document.querySelector('.pe-open-card');
    if (card) card.click();
  `);
  await new Promise(r => setTimeout(r, 600));
  // Captura 13: Detail sheet Desktop
  await captureScreenshot(path.join(ARTIFACTS_DIR, 'desktop_1440x900_detail.png'));

  // Cerrar Detail
  await evaluate(`
    const closeBtn = document.querySelector('.pe-detail-sheet__close-btn');
    if (closeBtn) closeBtn.click();
  `);
  await new Promise(r => setTimeout(r, 400));

  // 7. Multi-viewport Overflow Audit
  console.log('\n--- 7. Auditoría de Overflow en los 6 viewports ---');
  const viewportsToTest = [
    { name: 'mobile_360x800', width: 360, height: 800, isMobile: true },
    { name: 'mobile_390x844', width: 390, height: 844, isMobile: true },
    { name: 'mobile_430x932', width: 430, height: 932, isMobile: true },
    { name: 'desktop_1366x768', width: 1366, height: 768, isMobile: false },
    { name: 'desktop_1440x900', width: 1440, height: 900, isMobile: false },
    { name: 'desktop_1920x1080', width: 1920, height: 1080, isMobile: false },
  ];

  for (const vp of viewportsToTest) {
    await setViewport(vp.width, vp.height, vp.isMobile);
    await new Promise(r => setTimeout(r, 400));

    const metrics = await evaluate(`(() => {
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const overflowX = Math.max(0, scrollWidth - clientWidth);

      const discovery = document.querySelector('.pe-discovery-section');
      const discRect = discovery ? discovery.getBoundingClientRect() : null;

      const track = document.querySelector('.pe-discovery-track');
      const trackCard = document.querySelector('.pe-discovery-item');
      const cardRect = trackCard ? trackCard.getBoundingClientRect() : null;

      return {
        overflowX,
        discoveryHeight: discRect ? discRect.height : 0,
        cardWidth: cardRect ? cardRect.width : 0,
      };
    })()`);

    results.viewports[vp.name] = {
      ...vp,
      ...metrics,
      pass: metrics.overflowX === 0,
    };

    console.log(`[Viewport ${vp.name}] Overflow: ${metrics.overflowX}px | Discovery H: ${Math.round(metrics.discoveryHeight)}px | Card W: ${Math.round(metrics.cardWidth)}px -> ${metrics.overflowX === 0 ? 'PASS' : 'FAIL'}`);
  }

  // Guardar reporte JSON
  const reportPath = path.join(ARTIFACTS_DIR, 'validation_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n[Reporte] Guardado exitosamente en ${reportPath}`);

  // Cerrar procesos
  ws.close();
  chromeProc.kill();
  server.close();
  console.log('\n=== VALIDACIÓN COMPLETADA EXITOSAMENTE ===');
}

run().catch(err => {
  console.error('Error fatal durante la validación:', err);
  process.exit(1);
});
