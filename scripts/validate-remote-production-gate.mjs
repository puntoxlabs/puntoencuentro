import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const CDP_PORT = 9239;
const artifactsDir = path.join('C:', 'Users', 'Minar', '.gemini', 'antigravity', 'brain', '70d9face-fb29-4084-a777-b0b51f8d52f3', 'production-gsap-validation');

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

async function run() {
  console.log('=== VALIDACIÓN REMOTA EN PRODUCCIÓN (https://puntoencuentro.com.ar) ===');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-prod-val-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?https://puntoencuentro.com.ar`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!targetWs) throw new Error('No se pudo conectar a Chrome CDP');

    const ws = new WebSocket(targetWs);
    await new Promise(r => ws.on('open', r));

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const reqId = id++;
        const handler = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === reqId) {
            ws.off('message', handler);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: reqId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const report = {
      timestamp: new Date().toISOString(),
      codeSplitting: {},
      accessGate: {},
      previewGsap: {},
    };

    // 1. AUDITORÍA DE RED / CODE SPLITTING
    const networkUrls = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Network.requestWillBeSent') {
          networkUrls.push(msg.params.request.url);
        }
      } catch {}
    });

    const routesToCheck = [
      { name: 'home', url: 'https://puntoencuentro.com.ar/' },
      { name: 'home_d', url: 'https://puntoencuentro.com.ar/preview/home-d' },
      { name: 'create_ai', url: 'https://puntoencuentro.com.ar/create/ai' },
    ];

    for (const r of routesToCheck) {
      networkUrls.length = 0;
      await send('Page.navigate', { url: r.url });
      await new Promise(res => setTimeout(res, 2500));
      const loadedGsap = networkUrls.some(u => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
      report.codeSplitting[r.name] = {
        url: r.url,
        downloadedGsapChunk: loadedGsap,
        pass: !loadedGsap,
      };
      console.log(`Ruta ${r.url} -> ¿Descargó chunk GSAP?: ${loadedGsap ? 'SÍ (ERROR)' : 'NO (CORRECTO)'}`);
    }

    // 2. AUDITORÍA ACCESSGATE EN SESIÓN LIMPIA
    console.log('\n--- Probando /preview/home-gsap en sesión limpia ---');
    await send('Network.clearBrowserCookies');
    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-gsap' });
    await new Promise(res => setTimeout(res, 2000));

    const gateCheck = (await send('Runtime.evaluate', {
      expression: `(() => {
        const passwordInput = document.querySelector('input[type="password"]');
        const canvasGsap = document.querySelector('.home-dynamic-canvas--gsap');
        return {
          hasPasswordInput: Boolean(passwordInput),
          canvasGsapMountedBeforeAuth: Boolean(canvasGsap),
        };
      })()`,
      returnByValue: true,
    })).result.value;

    report.accessGate = {
      presentsPasswordInput: gateCheck.hasPasswordInput,
      canvasGsapBlockedBeforeAuth: !gateCheck.canvasGsapMountedBeforeAuth,
      pass: gateCheck.hasPasswordInput && !gateCheck.canvasGsapMountedBeforeAuth,
    };
    console.log(`AccessGate en sesión limpia: Muestra input pass=${gateCheck.hasPasswordInput}, Canvas GSAP bloqueado=${!gateCheck.canvasGsapMountedBeforeAuth}`);

    // Autorizar AccessGate
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    // 3. AUDITORÍA DE /preview/home-gsap AUTORIZADO EN 390x844
    console.log('\n--- Probando /preview/home-gsap autorizado en 390x844 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    networkUrls.length = 0;
    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-gsap' });

    // Esperar fuentes y renderizado GSAP
    await send('Runtime.evaluate', {
      expression: `new Promise(r => {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => setTimeout(r, 600));
        } else {
          setTimeout(r, 600);
        }
      })`,
      awaitPromise: true,
    });

    const gsapChunkLoaded = networkUrls.some(u => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
    console.log(`/preview/home-gsap -> ¿Descargó chunk GSAP?: ${gsapChunkLoaded ? 'SÍ (CORRECTO)' : 'NO (ERROR)'}`);

    // Capturar screenshot t=3s
    await new Promise(res => setTimeout(res, 2500));
    const ss390 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'prod_mobile_390x844_t3s.png'), Buffer.from(ss390.data, 'base64'));

    const eval390Expr = `(() => {
      const pL = document.querySelector('.home-gsap-mobile-frag--left');
      const pR = document.querySelector('.home-gsap-mobile-frag--right');
      const eb = document.querySelector('.home-hero-badge');
      const h1 = document.querySelector('.home-hero-title');
      const ph = document.querySelector('.home-hero-rotating-container');
      const metaRobots = document.querySelector('meta[name="robots"]')?.getAttribute('content');

      const pLR = pL ? pL.getBoundingClientRect() : null;
      const pRR = pR ? pR.getBoundingClientRect() : null;
      const ebR = eb ? eb.getBoundingClientRect() : null;
      const h1R = h1 ? h1.getBoundingClientRect() : null;
      const phR = ph ? ph.getBoundingClientRect() : null;

      function intersects(r1, r2) {
        if (!r1 || !r2) return false;
        if (r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const maxPhotoBottom = Math.max(pLR ? pLR.bottom : 0, pRR ? pRR.bottom : 0);
      const gapPhotosToEyebrow = ebR ? Math.round((ebR.top - maxPhotoBottom) * 10) / 10 : null;
      const gapPhotosToH1 = h1R ? Math.round((h1R.top - maxPhotoBottom) * 10) / 10 : null;

      const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).filter(t => {
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity || '0');
        const vis = cs.visibility !== 'hidden' && cs.display !== 'none' && op > 0.2;
        if (!vis) return false;
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      }).map(t => ({
        id: t.id,
        text: t.querySelector('.home-gsap-tag-text')?.textContent || '',
      }));

      const photoCollisions = {
        photoLeftEyebrow: intersects(pLR, ebR),
        photoLeftH1: intersects(pLR, h1R),
        photoLeftPhrase: intersects(pLR, phR),
        photoRightEyebrow: intersects(pRR, ebR),
        photoRightH1: intersects(pRR, h1R),
        photoRightPhrase: intersects(pRR, phR),
      };

      const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;

      return {
        metaRobots,
        gapPhotosToEyebrow,
        gapPhotosToH1,
        photoCollisions,
        hasPhotoCollision: Object.values(photoCollisions).some(Boolean),
        visibleTagsCount: tags.length,
        visibleTags: tags,
        hasOverflow,
      };
    })()`;

    const metrics390 = (await send('Runtime.evaluate', { expression: eval390Expr, returnByValue: true })).result.value;

    report.previewGsap = {
      gsapChunkLoaded,
      metaRobots: metrics390.metaRobots,
      gapPhotosToEyebrow: metrics390.gapPhotosToEyebrow,
      gapPhotosToH1: metrics390.gapPhotosToH1,
      hasPhotoCollision: metrics390.hasPhotoCollision,
      photoCollisions: metrics390.photoCollisions,
      visibleTagsCount: metrics390.visibleTagsCount,
      visibleTags: metrics390.visibleTags,
      hasOverflow: metrics390.hasOverflow,
    };

    console.log('Resultados de /preview/home-gsap en producción:', JSON.stringify(report.previewGsap, null, 2));

    const reportPath = path.join(artifactsDir, 'production_remote_gate_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Reporte guardado en: ${reportPath}`);

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('Error en validación remota:', err);
  process.exit(1);
});
