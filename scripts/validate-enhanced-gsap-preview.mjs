import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const LOCAL_PORT = 4173;
const CDP_PORT = 9244;
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
  'enhanced-gsap-validation'
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
  console.log('=== VALIDACIÓN COMPLETA REFINAMIENTO GSAP (MORFOLOGÍAS, TAMAÑOS Y CINEMÁTICA) ===\n');

  // 1. Iniciar Servidor HTTP Local
  console.log('[1/6] Iniciando servidor local http sobre dist/...');
  await new Promise((r) => server.listen(LOCAL_PORT, '127.0.0.1', r));
  console.log('      Servidor listo en ' + LOCAL_BASE);

  // 2. Iniciar Chrome Headless con CDP
  console.log('[2/6] Iniciando Google Chrome Headless CDP...');
  const profileDir = path.join(process.env.TEMP, 'chrome-val-enh-' + Date.now());
  const chromeProc = spawn(getChromePath(), [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
  ]);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${LOCAL_BASE}/`, { method: 'PUT' });
      if (resp.ok) {
        const tab = await resp.json();
        targetWs = tab.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!targetWs) throw new Error('No se pudo conectar a Chrome CDP');

  const ws = new WebSocket(targetWs);
  await new Promise((r) => ws.on('open', r));

  let reqId = 1;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expr) {
    const res = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('Eval error: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  async function screenshot(filename) {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, filename), buffer);
    console.log(`      [Screenshot] Guardado: ${filename}`);
  }

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const networkRequests = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Network.requestWillBeSent') {
          networkRequests.push(msg.params.request.url);
        }
      } catch {}
    });

    const report = {
      timestamp: new Date().toISOString(),
      codeSplitting: {},
      accessGate: {},
      viewports: {},
      morphologyFamilies: {},
      semanticCopy: {},
      f5Consistency: {},
    };

    // ── PARTE 1: CODE SPLITTING & AISLAMIENTO ──
    console.log('\n[3/6] Verificando Code Splitting y Aislamiento de GSAP...');
    const routes = [
      { name: 'home', path: '/' },
      { name: 'home_d', path: '/preview/home-d' },
      { name: 'create_ai', path: '/create/ai' },
    ];

    for (const r of routes) {
      networkRequests.length = 0;
      await send('Page.navigate', { url: `${LOCAL_BASE}${r.path}` });
      await new Promise((res) => setTimeout(res, 2000));
      const downloadedGsap = networkRequests.some((u) => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
      report.codeSplitting[r.name] = {
        path: r.path,
        downloadedGsap,
        pass: !downloadedGsap,
      };
      console.log(`      Ruta ${r.path} -> GSAP descargado: ${downloadedGsap ? 'SÍ (ERROR)' : 'NO (CORRECTO)'}`);
    }

    // ── PARTE 2: ACCESSGATE EN SESIÓN LIMPIA ──
    console.log('\n[4/6] Verificando AccessGate en sesión limpia...');
    await send('Network.clearBrowserCookies');
    await send('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
    await new Promise((res) => setTimeout(res, 2000));

    const gateClean = await evaluate(`(() => {
      return {
        hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
        canvasGsapMounted: Boolean(document.querySelector('.home-dynamic-canvas--gsap')),
      };
    })()`);

    // Autorizar AccessGate y navegar
    await evaluate(`localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`);
    await send('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
    await new Promise((res) => setTimeout(res, 2000));

    const gateAuthed = await evaluate(`(() => {
      return {
        canvasGsapMounted: Boolean(document.querySelector('.home-dynamic-canvas--gsap')),
        metaRobots: document.querySelector('meta[name="robots"]')?.getAttribute('content'),
      };
    })()`);

    report.accessGate = {
      presentsPasswordInput: gateClean.hasPasswordInput,
      canvasGsapBlockedBeforeAuth: !gateClean.canvasGsapMounted,
      canvasGsapMountedPostAuth: gateAuthed.canvasGsapMounted,
      metaRobots: gateAuthed.metaRobots,
      pass: gateClean.hasPasswordInput && !gateClean.canvasGsapMounted && gateAuthed.metaRobots === 'noindex, nofollow',
    };
    console.log(`      AccessGate sesión limpia: Password input=${gateClean.hasPasswordInput}, Canvas bloqueado=${!gateClean.canvasGsapMounted}`);
    console.log(`      AccessGate post-auth: Canvas montado=${gateAuthed.canvasGsapMounted}, Robots=${gateAuthed.metaRobots} (PASS=${report.accessGate.pass})`);

    // ── PARTE 3: AUDITORÍA DE MULTI-VIEWPORT, MORFOLOGÍAS Y COLISIONES ──
    console.log('\n[5/6] Evaluando Multi-Viewport, Morfologías, Tamaños y Cinemática...');

    const viewports = [
      { name: 'mobile_360x800', width: 360, height: 800, isMobile: true },
      { name: 'mobile_390x844', width: 390, height: 844, isMobile: true },
      { name: 'mobile_430x932', width: 430, height: 932, isMobile: true },
      { name: 'desktop_1366x768', width: 1366, height: 768, isMobile: false },
      { name: 'desktop_1440x900', width: 1440, height: 900, isMobile: false },
      { name: 'desktop_1920x1080', width: 1920, height: 1080, isMobile: false },
    ];

    const cdpEvalFunction = `(() => {
      const h1 = document.querySelector('.home-hero-title');
      const badge = document.querySelector('.home-hero-badge');
      const phrase = document.querySelector('.home-hero-rotating-container');
      const textarea = document.querySelector('.home-intent-textarea');
      const cta = document.querySelector('.home-intent-submit-btn');
      const chips = document.querySelector('.home-suggestions-container');
      const pillars = document.querySelector('.home-pillars-section');
      const fab = document.querySelector('.home-fab');
      const previewBadge = document.querySelector('button[title*="GSAP"], .home-gsap-preview-badge');
      
      const photoL = document.querySelector('.home-gsap-photo--left, .home-gsap-mobile-frag--left');
      const photoR = document.querySelector('.home-gsap-photo--right-top, .home-gsap-mobile-frag--right');
      const photoRB = document.querySelector('.home-gsap-photo--right-bottom');

      function getRect(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      }

      function intersects(r1, r2) {
        if (!r1 || !r2) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const h1R = getRect(h1);
      const badgeR = getRect(badge);
      const phraseR = getRect(phrase);
      const textareaR = getRect(textarea);
      const ctaR = getRect(cta);
      const chipsR = getRect(chips);
      const pillarsR = getRect(pillars);
      const fabR = getRect(fab);
      const previewBadgeR = getRect(previewBadge);
      const photoLR = getRect(photoL);
      const photoRR = getRect(photoR);
      const photoRBR = getRect(photoRB);

      const allTags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => {
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity || '0');
        const vis = cs.visibility !== 'hidden' && cs.display !== 'none' && op > 0.15;
        const r = getRect(t);
        const text = t.querySelector('.home-gsap-tag-text')?.textContent?.trim() || '';
        const id = t.id;
        const className = t.className;
        const fontSize = cs.fontSize;
        const padding = cs.padding;
        const clipPath = cs.clipPath;
        const borderRadius = cs.borderRadius;

        const collisions = {
          h1: intersects(r, h1R),
          badge: intersects(r, badgeR),
          phrase: intersects(r, phraseR),
          textarea: intersects(r, textareaR),
          cta: intersects(r, ctaR),
          chips: intersects(r, chipsR),
          pillars: intersects(r, pillarsR),
          fab: intersects(r, fabR),
          previewBadge: intersects(r, previewBadgeR),
        };

        return {
          id,
          text,
          className,
          visible: vis,
          opacity: op,
          rect: r,
          fontSize,
          padding,
          clipPath,
          borderRadius,
          hasCollision: Object.values(collisions).some(Boolean),
          collisions,
        };
      });

      const visibleTags = allTags.filter(t => t.visible);
      const overflowX = document.documentElement.scrollWidth - window.innerWidth;

      return {
        totalTags: allTags.length,
        visibleCount: visibleTags.length,
        visibleTags: visibleTags.map(t => ({
          id: t.id,
          text: t.text,
          rect: t.rect,
          fontSize: t.fontSize,
          className: t.className,
          hasCollision: t.hasCollision,
          collisions: t.collisions,
        })),
        hasAnyCollision: visibleTags.some(t => t.hasCollision),
        overflowX: Math.max(0, overflowX),
      };
    })()`;

    for (const vp of viewports) {
      console.log(`\n      Probando viewport ${vp.name} (${vp.width}x${vp.height})...`);
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: vp.isMobile,
      });

      networkRequests.length = 0;
      await send('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });

      // Esperar fonts y montaje GSAP
      await evaluate(`new Promise(r => {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => setTimeout(r, 600));
        } else {
          setTimeout(r, 600);
        }
      })`);

      const downloadedGsap = networkRequests.some((u) => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));

      // Muestrear durante 15 segundos
      const samples = [];
      const sampleInterval = 500;
      const totalDuration = 15000;
      const count = totalDuration / sampleInterval;

      let anyCollision = false;
      let maxOverflow = 0;
      const tagCounts = [];

      for (let s = 0; s < count; s++) {
        const metrics = await evaluate(cdpEvalFunction);
        samples.push(metrics);
        tagCounts.push(metrics.visibleCount);
        if (metrics.hasAnyCollision) anyCollision = true;
        if (metrics.overflowX > maxOverflow) maxOverflow = metrics.overflowX;
        await new Promise((res) => setTimeout(res, sampleInterval));
      }

      const sum = tagCounts.reduce((a, b) => a + b, 0);
      const avg = Math.round((sum / tagCounts.length) * 100) / 100;
      const min = Math.min(...tagCounts);
      const max = Math.max(...tagCounts);
      const gaps = tagCounts.filter((c) => c === 0).length;

      report.viewports[vp.name] = {
        width: vp.width,
        height: vp.height,
        downloadedGsap,
        avgVisibleTags: avg,
        minVisibleTags: min,
        maxVisibleTags: max,
        zeroTagGapsCount: gaps,
        hasCollision: anyCollision,
        maxOverflowX: maxOverflow,
        pass: !anyCollision && maxOverflow === 0 && gaps === 0 && (vp.isMobile ? min >= 1 : min >= 2),
      };

      console.log(`      Resultado ${vp.name}: Avg=${avg} (min ${min}, max ${max}), Gaps=${gaps}, Colisiones=${anyCollision}, Overflow=${maxOverflow}px -> ${report.viewports[vp.name].pass ? 'PASS' : 'FAIL'}`);
    }

    // ── PARTE 4: CAPTURAS DE EVIDENCIA VISUAL EXIGIDAS ──
    console.log('\n[6/6] Capturando evidencia fotográfica específica...');

    // A. Mobile 390x844
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    await send('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
    await new Promise((r) => setTimeout(r, 600));

    // t=0s
    await screenshot('mobile_390x844_t0s.png');

    // t=2.5s (tag superior Zona A: Pizza Ribbon grande)
    await new Promise((r) => setTimeout(r, 2500));
    await screenshot('mobile_390x844_t3s_upper_ribbon.png');

    // t=5.5s (tag inferior Zona C: Pádel Ticket troquelado)
    await new Promise((r) => setTimeout(r, 3000));
    await screenshot('mobile_390x844_t8s_lower_ticket.png');

    // Foco en textarea (Modo Calma)
    await evaluate(`(() => {
      const ta = document.querySelector('.home-intent-textarea');
      if (ta) ta.focus();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    await screenshot('mobile_390x844_modo_calma.png');

    // B. Desktop 1440x900
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${LOCAL_BASE}/preview/home-gsap` });
    await new Promise((r) => setTimeout(r, 600));

    // t=2.5s (Protagonista 1: Pizza Ribbon grande)
    await new Promise((r) => setTimeout(r, 2500));
    await screenshot('desktop_1440x900_t2s_protagonist_ribbon.png');

    // t=9.5s (Protagonista 2: Fútbol Blob orgánico grande)
    await new Promise((r) => setTimeout(r, 7000));
    await screenshot('desktop_1440x900_t9s_protagonist_blob.png');

    // t=18.5s (Protagonista 3: Bici Ribbon grande)
    await new Promise((r) => setTimeout(r, 9000));
    await screenshot('desktop_1440x900_t18s_bici_ribbon.png');

    // Convivencia con cards inferiores (scroll hacia abajo)
    await evaluate(`window.scrollTo({ top: 350, behavior: 'instant' });`);
    await new Promise((r) => setTimeout(r, 800));
    await screenshot('desktop_1440x900_t25s_coexistence_cards.png');
    await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' });`);

    // Desktop Modo Calma
    await evaluate(`(() => {
      const ta = document.querySelector('.home-intent-textarea');
      if (ta) ta.focus();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    await screenshot('desktop_1440x900_modo_calma.png');

    // Reduced Motion
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.reload');
    await new Promise((r) => setTimeout(r, 1200));
    await screenshot('desktop_1440x900_reduced_motion.png');
    await send('Emulation.setEmulatedMedia', { features: [] });

    // C. Verificación F5 vs Ctrl+F5 (Consistencia de estilos de fuentes/morfologías)
    console.log('\n      Verificando consistencia F5 vs Ctrl+F5...');
    await send('Page.reload');
    await new Promise((r) => setTimeout(r, 2000));
    await screenshot('desktop_f5_reload.png');
    const f5Styles = await evaluate(`(() => {
      const t = document.querySelector('#gt-pizza');
      const cs = window.getComputedStyle(t);
      return { fontSize: cs.fontSize, padding: cs.padding, clipPath: cs.clipPath };
    })()`);

    await send('Network.clearBrowserCache');
    await send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 2000));
    await screenshot('desktop_ctrl_f5_hard_reload.png');
    const ctrlF5Styles = await evaluate(`(() => {
      const t = document.querySelector('#gt-pizza');
      const cs = window.getComputedStyle(t);
      return { fontSize: cs.fontSize, padding: cs.padding, clipPath: cs.clipPath };
    })()`);

    const stylesMatch = JSON.stringify(f5Styles) === JSON.stringify(ctrlF5Styles);
    report.f5Consistency = {
      f5Styles,
      ctrlF5Styles,
      stylesMatch,
      pass: stylesMatch,
    };
    console.log(`      Consistencia F5 vs Ctrl+F5: ${stylesMatch ? 'IDENTICO 100% (PASS)' : 'DIFERENCIA DETECTADA'}`);

    // D. Verificación del Copy
    const copyAudit = await evaluate(`(() => {
      const texts = Array.from(document.querySelectorAll('.home-gsap-tag-text')).map(el => el.textContent.trim());
      const hasQuedan = texts.some(t => /quedan\\s+\\d+/i.test(t));
      const hasFalta1 = texts.includes('Pádel jueves · falta 1');
      const hasFaltan2 = texts.includes('Partido sábado · faltan 2');
      const hasFaltan3 = texts.includes('Salida en bici · faltan 3');
      const hasAbierto = texts.includes('Café y charla · abierto');
      return { texts, hasQuedan, hasFalta1, hasFaltan2, hasFaltan3, hasAbierto };
    })()`);

    report.semanticCopy = {
      ...copyAudit,
      pass: !copyAudit.hasQuedan && copyAudit.hasFalta1 && copyAudit.hasFaltan2 && copyAudit.hasFaltan3 && copyAudit.hasAbierto,
    };
    console.log(`      Auditoría Copy: Falta 1=${copyAudit.hasFalta1}, Faltan 2=${copyAudit.hasFaltan2}, Faltan 3=${copyAudit.hasFaltan3}, Abierto=${copyAudit.hasAbierto}, Quedan N=${copyAudit.hasQuedan ? 'SÍ (ERROR)' : 'NO (CORRECTO)'}`);

    // Guardar Reporte Final
    const reportPath = path.join(ARTIFACTS_DIR, 'enhanced_gsap_validation_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n=== VALIDACIÓN COMPLETA EXITOSA — Reporte guardado en: ${reportPath} ===`);

    ws.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

run().catch((err) => {
  console.error('Error durante la validación:', err);
  process.exit(1);
});
