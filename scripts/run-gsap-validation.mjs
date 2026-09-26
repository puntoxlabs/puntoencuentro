import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

const PORT = 4199;
const CDP_PORT = 9226;
const screenshotDir = 'C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/gsap-validation';
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

function getChromePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome no encontrado');
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const msgId = ++this.id;
    return new Promise((resolve, reject) => {
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async evaluate(expression) {
    let script = expression.trim();
    if ((script.includes('const ') || script.includes('let ')) && !script.startsWith('(')) {
      script = `(() => {\n${script}\n})()`;
    }
    const res = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async setViewport(width, height, isMobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: isMobile,
    });
    await this.send('Emulation.setVisibleSize', { width, height });
  }

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(screenshotDir, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`[Screenshot] Guardado: ${filename} (${buffer.length} bytes)`);
  }

  close() {
    try { this.ws.close(); } catch(e) {}
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const distDir = path.resolve('dist');
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
    res.end('Server error: ' + err.message);
  }
});

async function run() {
  console.log('===============================================================');
  console.log('VALIDACIÓN VISUAL & KINÉTICA DE LA RUTA GSAP (/preview/home-gsap)');
  console.log('===============================================================');

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Servidor local activo en http://127.0.0.1:${PORT}`);

  let chromeProc = null;
  let cdp = null;

  try {
    const chromePath = getChromePath();
    const profileDir = path.join(process.env.TEMP, 'chrome-gsap-qa-' + Date.now());
    chromeProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ]);

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
      await sleep(200);
    }
    if (!targetWs) throw new Error('No se pudo conectar a Chrome CDP');

    cdp = new CdpClient(targetWs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await sleep(1500);

    // Inyectar autorización AccessGate
    await cdp.evaluate(`
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
    `);

    const report = {
      timestamp: new Date().toISOString(),
      mobileMetrics390: [],
      desktopMetrics: [],
    };

    // ─────────────────────────────────────────────────────────────
    // 0. VERIFICACIÓN DE AISLAMIENTO: HOME PRODUCTIVA vs VARIANTE D vs GSAP
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 0. VERIFICACIÓN DE AISLAMIENTO DE RUTAS ---');
    // Verificar Home principal
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2000);
    const homeRootCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const hasStitchCanvas = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsapCanvas = !!document.querySelector('.home-dynamic-canvas--gsap');
        const badges = Array.from(document.querySelectorAll('.home-pillar-badge')).map(b => b.textContent?.trim() || '');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          pillarsCount: pillars.length,
          pillarTitles: titles,
          hasProximamente: badges.some(b => b.includes('Próximamente')),
          hasStitchCanvas,
          hasGsapCanvas,
          noIndex
        };
      })()
    `);
    report.homeRootCheck = homeRootCheck;
    console.log('Home Root (/):', homeRootCheck);

    // Verificar Preview Variante D (CSS)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
    await sleep(2000);
    const previewDCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const hasStitchCanvas = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsapCanvas = !!document.querySelector('.home-dynamic-canvas--gsap');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          pillarsCount: pillars.length,
          pillarTitles: titles,
          hasStitchCanvas,
          hasGsapCanvas,
          noIndex
        };
      })()
    `);
    report.previewDCheck = previewDCheck;
    console.log('Preview Variante D (/preview/home-d):', previewDCheck);

    // Verificar Preview GSAP
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });
    await sleep(2500);
    const previewGsapCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const hasStitchCanvas = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsapCanvas = !!document.querySelector('.home-dynamic-canvas--gsap');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
        const photos = Array.from(document.querySelectorAll('.home-gsap-photo, .home-gsap-mobile-frag'));
        return {
          pillarsCount: pillars.length,
          pillarTitles: titles,
          hasStitchCanvas,
          hasGsapCanvas,
          noIndex,
          tagsTotal: tags.length,
          photosTotal: photos.length
        };
      })()
    `);
    report.previewGsapCheck = previewGsapCheck;
    console.log('Preview GSAP (/preview/home-gsap):', previewGsapCheck);

    // ─────────────────────────────────────────────────────────────
    // 1. VALIDACIÓN MOBILE PRINCIPAL (390×844) — OBSERVACIÓN 30s
    // ─────────────────────────────────────────────────────────────
    console.log('\n===============================================================');
    console.log('1. VALIDACIÓN MOBILE PRINCIPAL (390×844) — OBSERVACIÓN 30s');
    console.log('===============================================================');
    await cdp.setViewport(390, 844, true);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2500);

    const mobileTimes = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30];
    const mStart = Date.now();

    for (const tSec of mobileTimes) {
      const elapsed = (Date.now() - mStart) / 1000;
      if (elapsed < tSec) {
        await sleep((tSec - elapsed) * 1000);
      }

      const mState = await cdp.evaluate(`
        (() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
          const visibleTags = [];

          const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
          const dynPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
          const textarea = document.querySelector('textarea')?.getBoundingClientRect();
          const cta = document.querySelector('.home-intent-submit-btn, button[type="submit"]')?.getBoundingClientRect();
          const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(c => c.getBoundingClientRect());
          const eyebrow = document.querySelector('.home-hero-badge')?.getBoundingClientRect();

          function collides(r1, r2) {
            if (!r1 || !r2) return false;
            return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
          }

          let colH1 = 0, colPhrase = 0, colTA = 0, colCTA = 0, colChips = 0, colEyebrow = 0;

          for (const t of tags) {
            const rect = t.getBoundingClientRect();
            const cs = window.getComputedStyle(t);
            const op = parseFloat(cs.opacity || '1');
            const vis = cs.visibility;
            const inViewport = (rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw);

            if (inViewport && vis !== 'hidden' && op > 0.1) {
              const text = t.querySelector('.home-gsap-tag-text')?.textContent || t.textContent.trim();
              visibleTags.push({
                id: t.id,
                text,
                opacity: Math.round(op * 100) / 100,
                rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) }
              });

              if (collides(rect, h1)) colH1++;
              if (collides(rect, dynPhrase)) colPhrase++;
              if (collides(rect, textarea)) colTA++;
              if (collides(rect, cta)) colCTA++;
              if (collides(rect, eyebrow)) colEyebrow++;
              for (const ch of chips) {
                if (collides(rect, ch)) colChips++;
              }
            }
          }

          const scrollW = document.documentElement.scrollWidth;
          const clientW = window.innerWidth;

          return {
            timeSec: ${tSec},
            visibleTagsCount: visibleTags.length,
            visibleTags,
            colH1,
            colPhrase,
            colTA,
            colCTA,
            colChips,
            colEyebrow,
            hasOverflow: scrollW > clientW
          };
        })()
      `);

      report.mobileMetrics390.push(mState);
      const tagNames = mState.visibleTags.map(v => v.text).join(' + ');
      console.log(`Mobile 390x844 t=${tSec}s: ${mState.visibleTagsCount} tags (${tagNames}), Colisiones: Phrase=${mState.colPhrase}, H1=${mState.colH1}, TA=${mState.colTA}, CTA=${mState.colCTA}, Chips=${mState.colChips}, Overflow=${mState.hasOverflow}`);

      if ([0, 5, 10, 15, 20, 25].includes(tSec)) {
        await cdp.screenshot(`mobile_gsap_390x844_t${tSec}s.png`);
      }
    }

    // Test Modo Calma Mobile
    console.log('\n--- TEST MODO CALMA (MOBILE 390×844) ---');
    await cdp.evaluate(`document.querySelector('textarea').focus();`);
    await sleep(900);
    await cdp.screenshot('mobile_gsap_390x844_modo_calma.png');
    const calmMobile = await cdp.evaluate(`
      (() => {
        const canvas = document.querySelector('.home-dynamic-canvas--gsap');
        const hasCalmClass = canvas.classList.contains('home-dynamic-canvas--calm');
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
        const opacities = tags.map(t => parseFloat(window.getComputedStyle(t).opacity || '0'));
        return { hasCalmClass, avgOpacity: opacities.reduce((a, b) => a + b, 0) / opacities.length };
      })()
    `);
    report.calmMobile = calmMobile;
    console.log('Modo Calma Mobile resultado:', calmMobile);
    await cdp.evaluate(`document.querySelector('textarea').blur();`);
    await sleep(900);

    // Test Reduced Motion Mobile
    console.log('\n--- TEST REDUCED MOTION (MOBILE 390×844) ---');
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2000);
    await cdp.screenshot('mobile_gsap_390x844_reduced_motion.png');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    // ─────────────────────────────────────────────────────────────
    // 2. VALIDACIÓN VIEWPORTS MOBILE ADICIONALES (360×800 y 430×932)
    // ─────────────────────────────────────────────────────────────
    console.log('\n===============================================================');
    console.log('2. VALIDACIÓN VIEWPORTS MOBILE ADICIONALES (360×800 y 430×932)');
    console.log('===============================================================');
    for (const vp of [{ w: 360, h: 800 }, { w: 430, h: 932 }]) {
      console.log(`Evaluando viewport ${vp.w}x${vp.h}...`);
      await cdp.setViewport(vp.w, vp.h, true);
      await cdp.send('Page.reload', { ignoreCache: true });
      await sleep(2500);

      const vpState = await cdp.evaluate(`
        (() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
          const visibleTags = tags.filter(t => {
            const rect = t.getBoundingClientRect();
            const cs = window.getComputedStyle(t);
            const op = parseFloat(cs.opacity || '1');
            return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw && cs.visibility !== 'hidden' && op > 0.1;
          });

          const dynPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
          const textarea = document.querySelector('textarea')?.getBoundingClientRect();
          const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();

          function collides(r1, r2) {
            if (!r1 || !r2) return false;
            return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
          }

          let cols = 0;
          for (const vt of visibleTags) {
            const r = vt.getBoundingClientRect();
            if (collides(r, dynPhrase) || collides(r, textarea) || collides(r, h1)) cols++;
          }

          return {
            visibleCount: visibleTags.length,
            hasOverflow: document.documentElement.scrollWidth > window.innerWidth,
            cols
          };
        })()
      `);

      report[`mobile_${vp.w}x${vp.h}`] = vpState;
      console.log(`Viewport ${vp.w}x${vp.h}: Tags visibles=${vpState.visibleCount}, Overflow=${vpState.hasOverflow}, Colisiones=${vpState.cols}`);
    }

    // ─────────────────────────────────────────────────────────────
    // 3. VALIDACIÓN DESKTOP (1440×900) — OBSERVACIÓN 30s
    // ─────────────────────────────────────────────────────────────
    console.log('\n===============================================================');
    console.log('3. VALIDACIÓN DESKTOP (1440×900) — OBSERVACIÓN 30s');
    console.log('===============================================================');
    await cdp.setViewport(1440, 900, false);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2500);

    const deskTimes = [0, 5, 10, 15, 20, 25, 30];
    const dStart = Date.now();

    for (const tSec of deskTimes) {
      const elapsed = (Date.now() - dStart) / 1000;
      if (elapsed < tSec) {
        await sleep((tSec - elapsed) * 1000);
      }

      const dState = await cdp.evaluate(`
        (() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
          const visibleTags = [];
          const colDetails = [];

          const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
          const dynPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
          const textarea = document.querySelector('textarea')?.getBoundingClientRect();
          const cta = document.querySelector('.home-intent-submit-btn, button[type="submit"]')?.getBoundingClientRect();
          const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(c => c.getBoundingClientRect());

          function collides(r1, r2) {
            if (!r1 || !r2) return false;
            return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
          }

          let functionalCollisions = 0;
          let phraseCollisions = 0;

          for (const t of tags) {
            const rect = t.getBoundingClientRect();
            const cs = window.getComputedStyle(t);
            const op = parseFloat(cs.opacity || '1');
            const vis = cs.visibility;
            const inViewport = (rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw);

            if (inViewport && vis !== 'hidden' && op > 0.1) {
              visibleTags.push(t);
              const colWith = [];
              if (collides(rect, h1)) colWith.push('h1');
              if (collides(rect, textarea)) colWith.push('textarea');
              if (collides(rect, cta)) colWith.push('cta');
              for (let ci = 0; ci < chips.length; ci++) {
                if (collides(rect, chips[ci])) colWith.push('chip_' + ci);
              }
              if (colWith.length > 0) {
                functionalCollisions++;
                colDetails.push({ id: t.id, text: t.textContent.trim(), colWith, rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) } });
              }
              if (collides(rect, dynPhrase)) phraseCollisions++;
            }
          }

          const largeCount = visibleTags.filter(t => t.classList.contains('home-gsap-tag--size-large')).length;
          const mediumCount = visibleTags.filter(t => t.classList.contains('home-gsap-tag--size-medium')).length;
          const smallCount = visibleTags.filter(t => t.classList.contains('home-gsap-tag--size-small')).length;

          return {
            timeSec: ${tSec},
            visibleCount: visibleTags.length,
            largeCount,
            mediumCount,
            smallCount,
            functionalCollisions,
            phraseCollisions,
            colDetails,
            hasOverflow: document.documentElement.scrollWidth > window.innerWidth
          };
        })()
      `);

      report.desktopMetrics.push(dState);
      console.log(`Desktop 1440x900 t=${tSec}s: ${dState.visibleCount} tags (Large: ${dState.largeCount}, Med: ${dState.mediumCount}, Small: ${dState.smallCount}), FuncCol=${dState.functionalCollisions}, PhraseCol=${dState.phraseCollisions}, Overflow=${dState.hasOverflow}`);

      if ([0, 5, 10, 15, 20, 25].includes(tSec)) {
        await cdp.screenshot(`desktop_gsap_1440x900_t${tSec}s.png`);
      }
    }

    // Modo Calma Desktop
    console.log('\n--- TEST MODO CALMA (DESKTOP 1440×900) ---');
    await cdp.evaluate(`document.querySelector('textarea').focus();`);
    await sleep(900);
    await cdp.screenshot('desktop_gsap_1440x900_modo_calma.png');
    await cdp.evaluate(`document.querySelector('textarea').blur();`);
    await sleep(900);

    // Reduced Motion Desktop
    console.log('\n--- TEST REDUCED MOTION (DESKTOP 1440×900) ---');
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2000);
    await cdp.screenshot('desktop_gsap_1440x900_reduced_motion.png');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    // ─────────────────────────────────────────────────────────────
    // 4. VIEWPORTS DESKTOP ADICIONALES (1366×768 y 1920×1080)
    // ─────────────────────────────────────────────────────────────
    console.log('\n===============================================================');
    console.log('4. VALIDACIÓN VIEWPORTS DESKTOP ADICIONALES (1366×768 y 1920×1080)');
    console.log('===============================================================');
    for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
      console.log(`Evaluando desktop ${vp.w}x${vp.h}...`);
      await cdp.setViewport(vp.w, vp.h, false);
      await cdp.send('Page.reload', { ignoreCache: true });
      await sleep(2500);

      const dVpState = await cdp.evaluate(`
        (() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
          const visibleTags = tags.filter(t => {
            const rect = t.getBoundingClientRect();
            const cs = window.getComputedStyle(t);
            const op = parseFloat(cs.opacity || '1');
            return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw && cs.visibility !== 'hidden' && op > 0.1;
          });

          return {
            visibleCount: visibleTags.length,
            hasOverflow: document.documentElement.scrollWidth > window.innerWidth
          };
        })()
      `);

      report[`desktop_${vp.w}x${vp.h}`] = dVpState;
      console.log(`Viewport Desktop ${vp.w}x${vp.h}: Tags visibles=${dVpState.visibleCount}, Overflow=${dVpState.hasOverflow}`);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. TEST DE CONSISTENCIA F5 (Normal) vs Ctrl+F5 (Hard Reload)
    // ─────────────────────────────────────────────────────────────
    console.log('\n===============================================================');
    console.log('5. TEST DE CONSISTENCIA F5 (Normal) vs Ctrl+F5 (Hard Reload)');
    console.log('===============================================================');
    await cdp.setViewport(1440, 900, false);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-gsap` });
    await sleep(2500);

    const f5Styles = await cdp.evaluate(`
      (() => {
        const getStyle = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = window.getComputedStyle(el);
          return { fontSize: cs.fontSize, padding: cs.padding };
        };
        return {
          large: getStyle('.home-gsap-tag--size-large'),
          medium: getStyle('.home-gsap-tag--size-medium'),
          small: getStyle('.home-gsap-tag--size-small')
        };
      })()
    `);
    await cdp.screenshot('desktop_gsap_f5_reload.png');

    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2500);

    const ctrlF5Styles = await cdp.evaluate(`
      (() => {
        const getStyle = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = window.getComputedStyle(el);
          return { fontSize: cs.fontSize, padding: cs.padding };
        };
        return {
          large: getStyle('.home-gsap-tag--size-large'),
          medium: getStyle('.home-gsap-tag--size-medium'),
          small: getStyle('.home-gsap-tag--size-small')
        };
      })()
    `);
    await cdp.screenshot('desktop_gsap_ctrl_f5_hard_reload.png');

    const isConsistent = JSON.stringify(f5Styles) === JSON.stringify(ctrlF5Styles);
    report.f5VsCtrlF5 = { f5Styles, ctrlF5Styles, isConsistent };
    console.log('F5 Styles (Normal):', JSON.stringify(f5Styles));
    console.log('Ctrl+F5 Styles (Hard Reload):', JSON.stringify(ctrlF5Styles));
    console.log('¿Consistencia F5 vs Ctrl+F5 100% idéntica?:', isConsistent ? 'SÍ (PASS)' : 'NO (FAIL)');

    fs.writeFileSync(path.join(screenshotDir, 'gsap_validation_report.json'), JSON.stringify(report, null, 2));
    console.log('\nReporte de validación GSAP guardado en gsap_validation_report.json');

  } finally {
    if (cdp) cdp.close();
    if (chromeProc) chromeProc.kill();
    server.close();
  }
}

run().catch((err) => {
  console.error('Error fatal durante la validación GSAP:', err);
  process.exit(1);
});
