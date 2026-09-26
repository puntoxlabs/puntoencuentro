import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 4199;
const CDP_PORT = 9237;
const distDir = path.resolve('dist');
const artifactsDir = path.join('C:', 'Users', 'Minar', '.gemini', 'antigravity', 'brain', '70d9face-fb29-4084-a777-b0b51f8d52f3', 'mobile-gsap-validation');

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
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

async function run() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`Server listening at http://127.0.0.1:${PORT}`);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'test-gate-evidence-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/preview/home-gsap`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!targetWs) throw new Error('Could not connect to Chrome debugging target');

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

    // Grant access gate
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    async function captureScreenshot(filename) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const filePath = path.join(artifactsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      console.log(`Saved screenshot: ${filename}`);
      return filePath;
    }

    const report = {
      timestamp: new Date().toISOString(),
      mobile390: {},
      desktop1440: {},
    };

    // ══════════════════════════════════════════════════════════════════
    // PART 1: MOBILE 390x844 (Screenshots at t=0, t=3, t=6, t=10)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n=== TESTING MOBILE 390x844 ===');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });

    // Wait for fonts & layout stabilization
    await send('Runtime.evaluate', {
      expression: `new Promise(r => {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => setTimeout(r, 450));
        } else {
          setTimeout(r, 500);
        }
      })`,
      awaitPromise: true,
    });

    const measureMobileGeometryExpr = `(() => {
      const pL = document.querySelector('.home-gsap-mobile-frag--left');
      const pR = document.querySelector('.home-gsap-mobile-frag--right');
      const eb = document.querySelector('.home-hero-badge');
      const h1 = document.querySelector('.home-hero-title');
      const ph = document.querySelector('.home-hero-rotating-container');
      const ta = document.querySelector('.home-intent-textarea');
      const ch = document.querySelector('.home-suggestion-chips');
      const c = document.querySelector('.home-dynamic-canvas--gsap');

      function toObj(r) {
        if (!r) return null;
        return {
          top: Math.round(r.top * 10) / 10,
          bottom: Math.round(r.bottom * 10) / 10,
          left: Math.round(r.left * 10) / 10,
          right: Math.round(r.right * 10) / 10,
          width: Math.round(r.width * 10) / 10,
          height: Math.round(r.height * 10) / 10,
        };
      }

      function intersects(r1, r2) {
        if (!r1 || !r2) return false;
        if (r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const pLR = pL ? pL.getBoundingClientRect() : null;
      const pRR = pR ? pR.getBoundingClientRect() : null;
      const ebR = eb ? eb.getBoundingClientRect() : null;
      const h1R = h1 ? h1.getBoundingClientRect() : null;
      const phR = ph ? ph.getBoundingClientRect() : null;
      const taR = ta ? ta.getBoundingClientRect() : null;
      const chR = ch ? ch.getBoundingClientRect() : null;
      const cR = c ? c.getBoundingClientRect() : null;

      const maxPhotoBottom = Math.max(pLR ? pLR.bottom : 0, pRR ? pRR.bottom : 0);
      const eyebrowTop = ebR ? ebR.top : 0;
      const h1Top = h1R ? h1R.top : 0;
      const gapPhotosToEyebrow = Math.round((eyebrowTop - maxPhotoBottom) * 10) / 10;
      const gapPhotosToH1 = Math.round((h1Top - maxPhotoBottom) * 10) / 10;

      const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).filter(t => {
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity || '0');
        const vis = cs.visibility !== 'hidden' && cs.display !== 'none' && op > 0.2;
        if (!vis) return false;
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      }).map(t => {
        const cs = window.getComputedStyle(t);
        const r = t.getBoundingClientRect();
        return {
          id: t.id,
          text: t.querySelector('.home-gsap-tag-text')?.textContent || '',
          opacity: Math.round(parseFloat(cs.opacity) * 100) / 100,
          rect: toObj(r),
        };
      });

      let tagCollisions = { withEyebrow: 0, withH1: 0, withPhrase: 0, withPhotos: 0 };
      tags.forEach(t => {
        if (intersects(t.rect, ebR)) tagCollisions.withEyebrow++;
        if (intersects(t.rect, h1R)) tagCollisions.withH1++;
        if (intersects(t.rect, phR)) tagCollisions.withPhrase++;
        if (intersects(t.rect, pLR) || intersects(t.rect, pRR)) tagCollisions.withPhotos++;
      });

      return {
        photoLeft: toObj(pLR),
        photoRight: toObj(pRR),
        eyebrow: toObj(ebR),
        h1: toObj(h1R),
        phrase: toObj(phR),
        gapPhotosToEyebrow,
        gapPhotosToH1,
        visibleTagsCount: tags.length,
        visibleTags: tags,
        tagCollisions,
      };
    })()`;

    // Measure t=0s
    const m0 = (await send('Runtime.evaluate', { expression: measureMobileGeometryExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t0.png');
    report.mobile390.t0 = m0;

    // Wait until t=3s
    await new Promise(r => setTimeout(r, 3000));
    const m3 = (await send('Runtime.evaluate', { expression: measureMobileGeometryExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t3.png');
    report.mobile390.t3 = m3;

    // Wait until t=6s (3s more)
    await new Promise(r => setTimeout(r, 3000));
    const m6 = (await send('Runtime.evaluate', { expression: measureMobileGeometryExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t6.png');
    report.mobile390.t6 = m6;

    // Wait until t=10s (4s more)
    await new Promise(r => setTimeout(r, 4000));
    const m10 = (await send('Runtime.evaluate', { expression: measureMobileGeometryExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t10.png');
    report.mobile390.t10 = m10;

    // ══════════════════════════════════════════════════════════════════
    // PART 2: DESKTOP 1440x900 (Screenshots at t=0, t=5, t=10, t=15 + Full 30s Loop)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n=== TESTING DESKTOP 1440x900 ===');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.0, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });

    // Wait for fonts & layout stabilization
    await send('Runtime.evaluate', {
      expression: `new Promise(r => {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => setTimeout(r, 450));
        } else {
          setTimeout(r, 500);
        }
      })`,
      awaitPromise: true,
    });

    const measureDesktopExpr = `(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
      const deskPhotos = Array.from(document.querySelectorAll('.home-gsap-photo'));
      const mobileFrags = Array.from(document.querySelectorAll('.home-gsap-mobile-frag'));

      const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
      const dynPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
      const textarea = document.querySelector('textarea')?.getBoundingClientRect();
      const cta = document.querySelector('.home-intent-submit-btn, button[type="submit"]')?.getBoundingClientRect();
      const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(c => c.getBoundingClientRect());

      function collides(r1, r2) {
        if (!r1 || !r2) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const visibleTags = [];
      let functionalCollisions = 0;

      for (const t of tags) {
        const rect = t.getBoundingClientRect();
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity || '0');
        const vis = cs.visibility !== 'hidden' && cs.display !== 'none';
        const inViewport = (rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw);

        if (inViewport && vis && op > 0.15) {
          const sizeTier = t.classList.contains('home-gsap-tag--size-large') ? 'large' : (t.classList.contains('home-gsap-tag--size-small') ? 'small' : 'medium');
          visibleTags.push({
            id: t.id,
            text: t.querySelector('.home-gsap-tag-text')?.textContent || '',
            sizeTier,
            opacity: Math.round(op * 100) / 100,
          });

          if (collides(rect, h1) || collides(rect, textarea) || collides(rect, cta)) {
            functionalCollisions++;
          }
          for (const c of chips) {
            if (collides(rect, c)) functionalCollisions++;
          }
        }
      }

      const largeCount = visibleTags.filter(t => t.sizeTier === 'large').length;
      const mediumCount = visibleTags.filter(t => t.sizeTier === 'medium').length;
      const smallCount = visibleTags.filter(t => t.sizeTier === 'small').length;

      const deskPhotosVisible = deskPhotos.filter(p => {
        const cs = window.getComputedStyle(p);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '0') > 0.1;
      }).length;

      const mobileFragsVisible = mobileFrags.filter(f => {
        const cs = window.getComputedStyle(f);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      }).length;

      return {
        visibleCount: visibleTags.length,
        largeCount,
        mediumCount,
        smallCount,
        functionalCollisions,
        deskPhotosVisible,
        mobileFragsVisible,
        visibleTags,
      };
    })()`;

    // t=0s
    const d0 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    await captureScreenshot('desktop_1440x900_t0.png');
    report.desktop1440.t0 = d0;

    // t=5s
    await new Promise(r => setTimeout(r, 5000));
    const d5 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    await captureScreenshot('desktop_1440x900_t5.png');
    report.desktop1440.t5 = d5;

    // t=10s (5s more)
    await new Promise(r => setTimeout(r, 5000));
    const d10 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    await captureScreenshot('desktop_1440x900_t10.png');
    report.desktop1440.t10 = d10;

    // t=15s (5s more)
    await new Promise(r => setTimeout(r, 5000));
    const d15 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    await captureScreenshot('desktop_1440x900_t15.png');
    report.desktop1440.t15 = d15;

    // t=20s (5s more)
    await new Promise(r => setTimeout(r, 5000));
    const d20 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    report.desktop1440.t20 = d20;

    // t=25s (5s more)
    await new Promise(r => setTimeout(r, 5000));
    const d25 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    report.desktop1440.t25 = d25;

    // t=30s (5s more)
    await new Promise(r => setTimeout(r, 5000));
    const d30 = (await send('Runtime.evaluate', { expression: measureDesktopExpr, returnByValue: true })).result.value;
    report.desktop1440.t30 = d30;

    const deskSamples = [d0.visibleCount, d5.visibleCount, d10.visibleCount, d15.visibleCount, d20.visibleCount, d25.visibleCount, d30.visibleCount];
    const deskAvg = deskSamples.reduce((a, b) => a + b, 0) / deskSamples.length;
    const deskMin = Math.min(...deskSamples);
    const deskMax = Math.max(...deskSamples);

    report.desktop1440.summary = {
      samples: deskSamples,
      avg: Math.round(deskAvg * 100) / 100,
      min: deskMin,
      max: deskMax,
    };

    console.log(`\nDesktop 30s Loop: samples=[${deskSamples.join(', ')}], avg=${report.desktop1440.summary.avg}, min=${deskMin}, max=${deskMax}`);

    // Save report
    const jsonPath = path.join(artifactsDir, 'gate_evidence_report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`Saved gate evidence report to ${jsonPath}`);

    ws.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

run().catch(err => {
  console.error('Error running gate evidence:', err);
  process.exit(1);
});
