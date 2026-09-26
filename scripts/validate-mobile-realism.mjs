import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 4198;
const CDP_PORT = 9236;
const distDir = path.resolve('dist');
const artifactsDir = 'C:\\Users\\Minar\\.gemini\\antigravity\\brain\\70d9face-fb29-4084-a777-b0b51f8d52f3\\mobile-gsap-validation';

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

async function runValidation() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`Server listening at http://127.0.0.1:${PORT}`);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'test-mobile-gsap-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/preview/home-gsap?debugMotion=1`, { method: 'PUT' });
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

    const report = {
      timestamp: new Date().toISOString(),
      viewportsTested: [],
      resultsByViewport: {},
    };

    // MEASUREMENT FUNCTION
    const evaluateDOMMetricsExpr = `(() => {
      const container = document.querySelector('.home-dynamic-canvas--gsap');
      const heroWrapper = document.querySelector('.home-hero-wrapper');
      const photoLeft = document.querySelector('.home-gsap-mobile-frag--left');
      const photoRight = document.querySelector('.home-gsap-mobile-frag--right');
      const deskPhotos = Array.from(document.querySelectorAll('.home-gsap-photo'));
      const eyebrow = document.querySelector('.home-hero-badge');
      const h1 = document.querySelector('.home-hero-title');
      const phrase = document.querySelector('.home-hero-rotating-container');
      const textarea = document.querySelector('.home-intent-textarea');
      const cta = document.querySelector('.home-intent-cta');
      const chips = document.querySelector('.home-suggestion-chips');
      const hud = document.querySelector('.home-gsap-debug-hud');

      const allTags = Array.from(document.querySelectorAll('.home-gsap-tag'));
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const vv = window.visualViewport;

      function toObj(rect) {
        if (!rect) return null;
        return {
          top: Math.round(rect.top * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      }

      function intersects(r1, r2) {
        if (!r1 || !r2) return false;
        // Ignore 0-area
        if (r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const pLRect = photoLeft ? photoLeft.getBoundingClientRect() : null;
      const pRRect = photoRight ? photoRight.getBoundingClientRect() : null;
      const ebRect = eyebrow ? eyebrow.getBoundingClientRect() : null;
      const h1Rect = h1 ? h1.getBoundingClientRect() : null;
      const phRect = phrase ? phrase.getBoundingClientRect() : null;
      const taRect = textarea ? textarea.getBoundingClientRect() : null;
      const ctaRect = cta ? cta.getBoundingClientRect() : null;
      const chRect = chips ? chips.getBoundingClientRect() : null;
      const cRect = container ? container.getBoundingClientRect() : null;

      // Desktop photos visible on mobile?
      const deskPhotosVisibleCount = deskPhotos.filter(el => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.05;
      }).length;

      // Active & visible tags
      const visibleTags = allTags.filter(tag => {
        const style = window.getComputedStyle(tag);
        const opacity = parseFloat(style.opacity || '0');
        const isVis = style.visibility !== 'hidden' && style.display !== 'none' && opacity > 0.2;
        if (!isVis) return false;
        const rect = tag.getBoundingClientRect();
        // Check if within visual viewport bounds
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      }).map(t => {
        const style = window.getComputedStyle(t);
        const rect = t.getBoundingClientRect();
        return {
          id: t.id,
          text: t.querySelector('.home-gsap-tag-text')?.textContent || '',
          opacity: Math.round(parseFloat(style.opacity) * 100) / 100,
          rect: toObj(rect),
        };
      });

      // Collisions check for active visible tags
      let tagCollisions = {
        withEyebrow: 0,
        withH1: 0,
        withPhrase: 0,
        withTextarea: 0,
        withCta: 0,
        withChips: 0,
        withPhotos: 0,
      };

      visibleTags.forEach(t => {
        if (intersects(t.rect, ebRect)) tagCollisions.withEyebrow++;
        if (intersects(t.rect, h1Rect)) tagCollisions.withH1++;
        if (intersects(t.rect, phRect)) tagCollisions.withPhrase++;
        if (intersects(t.rect, taRect)) tagCollisions.withTextarea++;
        if (intersects(t.rect, ctaRect)) tagCollisions.withCta++;
        if (intersects(t.rect, chRect)) tagCollisions.withChips++;
        if (intersects(t.rect, pLRect) || intersects(t.rect, pRRect)) tagCollisions.withPhotos++;
      });

      // Photo collisions with hero text
      const photoCollisions = {
        photoLeftEyebrow: intersects(pLRect, ebRect),
        photoLeftH1: intersects(pLRect, h1Rect),
        photoLeftPhrase: intersects(pLRect, phRect),
        photoRightEyebrow: intersects(pRRect, ebRect),
        photoRightH1: intersects(pRRect, h1Rect),
        photoRightPhrase: intersects(pRRect, phRect),
      };

      const hasPhotoCollision = Object.values(photoCollisions).some(Boolean);

      return {
        viewport: {
          innerWidth: vw,
          innerHeight: vh,
          visualViewport: vv ? { width: Math.round(vv.width), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) } : null,
          devicePixelRatio: window.devicePixelRatio,
        },
        containerRect: toObj(cRect),
        photoLeftRect: toObj(pLRect),
        photoRightRect: toObj(pRRect),
        eyebrowRect: toObj(ebRect),
        h1Rect: toObj(h1Rect),
        phraseRect: toObj(phRect),
        chipsRect: toObj(chRect),
        deskPhotosVisibleCount,
        hudPresent: Boolean(hud),
        photoCollisions,
        hasPhotoCollision,
        visibleTagsCount: visibleTags.length,
        visibleTags,
        tagCollisions,
      };
    })()`;

    async function captureScreenshot(filename) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const filePath = path.join(artifactsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      console.log(`Saved screenshot: ${filename}`);
      return filePath;
    }

    // ══════════════════════════════════════════════════════════════════
    // VIEWPORT 1: 390x844 (iPhone 12/13/14 / Modern Standard Mobile)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n--- Testing Viewport 390x844 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap?debugMotion=1` });
    await new Promise(r => setTimeout(r, 1200));

    // t = 0s immediately after load
    const t0Metrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t0s.png');

    // t = +2s
    await new Promise(r => setTimeout(r, 2000));
    const t2Metrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t2s.png');

    // t = +5s
    await new Promise(r => setTimeout(r, 3000));
    const t5Metrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t5s.png');

    // Dynamic interaction: Scroll down 60px and scroll back
    await send('Runtime.evaluate', { expression: `window.scrollTo({ top: 60, behavior: 'instant' });` });
    await new Promise(r => setTimeout(r, 600));
    await send('Runtime.evaluate', { expression: `window.scrollTo({ top: 0, behavior: 'instant' });` });
    await new Promise(r => setTimeout(r, 600));

    // Address bar simulation (height resize: 844 -> 770 -> 844)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 770, deviceScaleFactor: 2.6, mobile: true });
    await new Promise(r => setTimeout(r, 600));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    await new Promise(r => setTimeout(r, 600));

    // Focus textarea -> Modo Calma
    await send('Runtime.evaluate', {
      expression: `(() => {
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.focus();
          ta.dispatchEvent(new Event('focus', { bubbles: true }));
        }
      })()`
    });
    await new Promise(r => setTimeout(r, 800));
    const modoCalmaMetrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_modo_calma.png');

    // Blur textarea
    await send('Runtime.evaluate', {
      expression: `(() => {
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.blur();
          ta.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      })()`
    });
    await new Promise(r => setTimeout(r, 800));

    // t = +10s
    await new Promise(r => setTimeout(r, 1500));
    const t10Metrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t10s.png');

    // t = +20s
    await new Promise(r => setTimeout(r, 10000));
    const t20Metrics = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_390x844_t20s.png');

    // 30 seconds observation loop (1 sample per second)
    console.log('Running 30s continuous observation sample loop...');
    const samples = [];
    for (let s = 0; s < 30; s++) {
      const data = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
      samples.push({
        second: s,
        visibleCount: data.visibleTagsCount,
        tagIds: data.visibleTags.map(t => t.id),
        hasPhotoCollision: data.hasPhotoCollision,
        tagCollisions: data.tagCollisions,
      });
      await new Promise(r => setTimeout(r, 1000));
    }

    const counts = samples.map(s => s.visibleCount);
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const gapSeconds = samples.filter(s => s.visibleCount === 0).length;
    const totalTagCollisions = samples.reduce((acc, s) => {
      return acc + Object.values(s.tagCollisions).reduce((a, b) => a + b, 0);
    }, 0);
    const photoCollisionsCount = samples.filter(s => s.hasPhotoCollision).length;

    report.viewportsTested.push('390x844');
    report.resultsByViewport['390x844'] = {
      t0: t0Metrics,
      t2: t2Metrics,
      t5: t5Metrics,
      t10: t10Metrics,
      t20: t20Metrics,
      modoCalma: modoCalmaMetrics,
      observation30s: {
        avgCount: Math.round(avgCount * 100) / 100,
        minCount,
        maxCount,
        gapSeconds,
        totalTagCollisions,
        photoCollisionsCount,
      }
    };

    console.log(`390x844 Observation 30s: avg=${avgCount.toFixed(2)}, min=${minCount}, max=${maxCount}, gaps=${gapSeconds}s, collisions=${totalTagCollisions}, photoCollisions=${photoCollisionsCount}`);

    // ══════════════════════════════════════════════════════════════════
    // VIEWPORT 2: 360x800 (Compact Android / Galaxy A / Pixel compact)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n--- Testing Viewport 360x800 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2.0, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 2000));
    const v360_t5 = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_360x800_t5s.png');

    const samples360 = [];
    for (let s = 0; s < 15; s++) {
      const data = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
      samples360.push(data.visibleTagsCount);
      await new Promise(r => setTimeout(r, 1000));
    }
    const avg360 = samples360.reduce((a, b) => a + b, 0) / samples360.length;
    report.viewportsTested.push('360x800');
    report.resultsByViewport['360x800'] = {
      t5: v360_t5,
      avgCount: Math.round(avg360 * 100) / 100,
      minCount: Math.min(...samples360),
      maxCount: Math.max(...samples360),
      hasPhotoCollision: v360_t5.hasPhotoCollision,
    };
    console.log(`360x800 Observation 15s: avg=${avg360.toFixed(2)}, min=${Math.min(...samples360)}, max=${Math.max(...samples360)}, photoCollisions=${v360_t5.hasPhotoCollision}`);

    // ══════════════════════════════════════════════════════════════════
    // VIEWPORT 3: 430x932 (Large Device / Pro Max / Plus)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n--- Testing Viewport 430x932 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 3.0, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 2000));
    const v430_t5 = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('mobile_430x932_t5s.png');

    const samples430 = [];
    for (let s = 0; s < 15; s++) {
      const data = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
      samples430.push(data.visibleTagsCount);
      await new Promise(r => setTimeout(r, 1000));
    }
    const avg430 = samples430.reduce((a, b) => a + b, 0) / samples430.length;
    report.viewportsTested.push('430x932');
    report.resultsByViewport['430x932'] = {
      t5: v430_t5,
      avgCount: Math.round(avg430 * 100) / 100,
      minCount: Math.min(...samples430),
      maxCount: Math.max(...samples430),
      hasPhotoCollision: v430_t5.hasPhotoCollision,
    };
    console.log(`430x932 Observation 15s: avg=${avg430.toFixed(2)}, min=${Math.min(...samples430)}, max=${Math.max(...samples430)}, photoCollisions=${v430_t5.hasPhotoCollision}`);

    // ══════════════════════════════════════════════════════════════════
    // DESKTOP SANITY CHECK: 1440x900
    // ══════════════════════════════════════════════════════════════════
    console.log('\n--- Testing Desktop Sanity 1440x900 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.0, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 2000));
    const deskData = (await send('Runtime.evaluate', { expression: evaluateDOMMetricsExpr, returnByValue: true })).result.value;
    await captureScreenshot('desktop_1440x900_sanity.png');

    report.desktopSanity = {
      deskPhotosVisibleCount: deskData.deskPhotosVisibleCount,
      visibleTagsCount: deskData.visibleTagsCount,
    };

    // Save JSON report
    const reportPath = path.join(artifactsDir, 'mobile_validation_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Saved report: ${reportPath}`);

    ws.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

runValidation().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});
