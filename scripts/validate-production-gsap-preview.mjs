import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

const PROD_BASE = 'https://puntoencuentro.com.ar';
const CDP_PORT = 9228;
const screenshotDir = 'C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/production-gsap-validation';
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
    this.networkRequests = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params?.request?.url;
        if (url && (url.includes('.js') || url.includes('.css'))) {
          this.networkRequests.push(url);
        }
      }
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

  clearRequests() {
    this.networkRequests = [];
  }

  close() {
    try { this.ws.close(); } catch(e) {}
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('===============================================================');
  console.log('VALIDACIÓN COMPLETA DE PRODUCCIÓN (PuntoEncuentro.com.ar)');
  console.log('Ruta objetivo: https://puntoencuentro.com.ar/preview/home-gsap');
  console.log('===============================================================');

  const chromePath = getChromePath();
  const profileDir = path.join(process.env.TEMP, 'chrome-prod-val-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ]);

  let cdp = null;

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${PROD_BASE}/preview/home-gsap`, { method: 'PUT' });
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
    await sleep(2000);

    const report = {
      timestamp: new Date().toISOString(),
      productionUrl: PROD_BASE,
      mobileMetrics: [],
      desktopMetrics: [],
    };

    // ─────────────────────────────────────────────────────────────
    // 1. VALIDACIÓN ACCESSGATE EN SESIÓN LIMPIA (Sin autorización)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 1. TEST ACCESSGATE EN SESIÓN LIMPIA ---');
    const accessGateCheck = await cdp.evaluate(`
      (() => {
        const hasForm = !!document.querySelector('form');
        const h2 = document.querySelector('h2')?.textContent?.trim() || '';
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';
        const hasGsapCanvas = !!document.querySelector('.home-dynamic-canvas--gsap');
        const hasHero = !!document.querySelector('.home-hero-title');
        const hasPasswordInput = !!document.querySelector('input[type="password"]');
        return {
          h1,
          h2,
          hasForm,
          hasPasswordInput,
          hasGsapCanvas,
          hasHero,
          currentUrl: window.location.href
        };
      })()
    `);
    console.log('AccessGate en sesión limpia:', accessGateCheck);
    report.accessGateCheck = accessGateCheck;
    await cdp.screenshot('prod_accessgate_clean.png');

    // Autorizar mediante localStorage (sin exponer contraseñas en logs ni código)
    console.log('Autorizando sesión en localStorage...');
    await cdp.evaluate(`
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
    `);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3000);

    const afterAuthCheck = await cdp.evaluate(`
      (() => {
        const hasGsapCanvas = !!document.querySelector('.home-dynamic-canvas--gsap');
        const hasBadge = !!document.querySelector('button[title*="GSAP"]');
        const badgeText = document.querySelector('button[title*="GSAP"]')?.textContent?.trim() || '';
        const noIndexMeta = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          hasGsapCanvas,
          hasBadge,
          badgeText,
          noIndexMeta,
          currentPath: window.location.pathname
        };
      })()
    `);
    console.log('Post-autorización AccessGate:', afterAuthCheck);
    report.afterAuthCheck = afterAuthCheck;
    await cdp.screenshot('prod_after_accessgate_authorized.png');

    // ─────────────────────────────────────────────────────────────
    // 2. AUDITORÍA DE RED Y CODE SPLITTING EN PRODUCCIÓN EN VIVO
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 2. AUDITORÍA DE RED Y CODE SPLITTING EN PRODUCCIÓN ---');
    const routesToAudit = [
      { name: 'Home principal (/)', url: `${PROD_BASE}/`, shouldHaveGsap: false },
      { name: 'Preview Variante D (/preview/home-d)', url: `${PROD_BASE}/preview/home-d`, shouldHaveGsap: false },
      { name: 'Wizard AI (/create/ai)', url: `${PROD_BASE}/create/ai`, shouldHaveGsap: false },
      { name: 'Preview GSAP (/preview/home-gsap)', url: `${PROD_BASE}/preview/home-gsap`, shouldHaveGsap: true },
    ];

    const networkAuditResults = [];
    for (const r of routesToAudit) {
      cdp.clearRequests();
      await cdp.send('Page.navigate', { url: r.url });
      await sleep(3500);

      const requests = [...cdp.networkRequests];
      const hasGsapChunk = requests.some(u => u.includes('HomeDynamicCanvasGsap'));
      const chunkNames = requests.map(u => u.split('/').pop().split('?')[0]);
      const passed = hasGsapChunk === r.shouldHaveGsap;

      networkAuditResults.push({
        name: r.name,
        url: r.url,
        shouldHaveGsap: r.shouldHaveGsap,
        hasGsapChunk,
        passed,
        chunksLoaded: chunkNames
      });

      console.log(`Ruta ${r.name}:`);
      console.log(`  ¿Descargó chunk GSAP?: ${hasGsapChunk ? 'SÍ' : 'NO'}`);
      console.log(`  Resultado: ${passed ? 'PASS (Aislamiento verificado)' : 'FAIL'}`);
      console.log(`  Chunks: ${chunkNames.join(', ')}`);
    }
    report.networkAuditResults = networkAuditResults;

    // ─────────────────────────────────────────────────────────────
    // 3. VERIFICACIÓN DE ESTRUCTURA Y PILARES EN CADA RUTA
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 3. VERIFICACIÓN DE AISLAMIENTO ESTRUCTURAL ---');
    // Home principal
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/` });
    await sleep(2500);
    const homeProdCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const badges = Array.from(document.querySelectorAll('.home-pillar-badge')).map(b => b.textContent?.trim() || '');
        const hasStitch = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsap = !!document.querySelector('.home-dynamic-canvas--gsap');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          pillarsCount: pillars.length,
          titles,
          badges,
          hasStitch,
          hasGsap,
          noIndex
        };
      })()
    `);
    console.log('Home productiva (/):', homeProdCheck);
    report.homeProdCheck = homeProdCheck;

    // Variante D CSS
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/preview/home-d` });
    await sleep(2500);
    const previewDProdCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const badges = Array.from(document.querySelectorAll('.home-pillar-badge, .home-pillar-status-tag')).map(b => b.textContent?.trim() || '');
        const hasStitch = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsap = !!document.querySelector('.home-dynamic-canvas--gsap');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          pillarsCount: pillars.length,
          titles,
          badges,
          hasStitch,
          hasGsap,
          noIndex
        };
      })()
    `);
    console.log('Preview Variante D (/preview/home-d):', previewDProdCheck);
    report.previewDProdCheck = previewDProdCheck;

    // Preview GSAP
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/preview/home-gsap` });
    await sleep(2500);
    const previewGsapProdCheck = await cdp.evaluate(`
      (() => {
        const pillars = Array.from(document.querySelectorAll('.home-pillar-card'));
        const titles = pillars.map(p => p.querySelector('.home-pillar-title')?.textContent?.trim() || '');
        const badges = Array.from(document.querySelectorAll('.home-pillar-badge, .home-pillar-status-tag')).map(b => b.textContent?.trim() || '');
        const hasStitch = !!document.querySelector('.home-dynamic-canvas--stitch');
        const hasGsap = !!document.querySelector('.home-dynamic-canvas--gsap');
        const noIndex = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        return {
          pillarsCount: pillars.length,
          titles,
          badges,
          hasStitch,
          hasGsap,
          noIndex
        };
      })()
    `);
    console.log('Preview GSAP (/preview/home-gsap):', previewGsapProdCheck);
    report.previewGsapProdCheck = previewGsapProdCheck;

    // ─────────────────────────────────────────────────────────────
    // 4. OBSERVACIÓN MOBILE 390×844 EN PRODUCCIÓN (30s)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 4. OBSERVACIÓN MOBILE 390×844 EN PRODUCCIÓN (30s) ---');
    await cdp.setViewport(390, 844, true);
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/preview/home-gsap` });
    await sleep(2500);

    const mobileTimes = [0, 5, 10, 15, 20, 25, 30];
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
                text,
                opacity: Math.round(op * 100) / 100,
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

          return {
            timeSec: ${tSec},
            visibleTagsCount: visibleTags.length,
            visibleTagsText: visibleTags.map(v => v.text),
            protagonista: visibleTags[0]?.text || 'Ninguno',
            colH1,
            colPhrase,
            colTA,
            colCTA,
            colChips,
            colEyebrow,
            hasOverflow: document.documentElement.scrollWidth > window.innerWidth
          };
        })()
      `);

      report.mobileMetrics.push(mState);
      console.log(`Mobile t=${tSec}s: ${mState.visibleTagsCount} tags (${mState.visibleTagsText.join(' + ')}), Colisiones: Phrase=${mState.colPhrase}, TA=${mState.colTA}, CTA=${mState.colCTA}, Chips=${mState.colChips}, Overflow=${mState.hasOverflow}`);

      if ([0, 15, 30].includes(tSec)) {
        await cdp.screenshot(`prod_mobile_390x844_t${tSec}s.png`);
      }
    }

    // Modo Calma Mobile en producción
    console.log('\n--- MODO CALMA MOBILE ---');
    await cdp.evaluate(`document.querySelector('textarea').focus();`);
    await sleep(900);
    const calmMobile = await cdp.evaluate(`
      (() => {
        const canvas = document.querySelector('.home-dynamic-canvas--gsap');
        const hasCalmClass = canvas.classList.contains('home-dynamic-canvas--calm');
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag'));
        const opacities = tags.map(t => parseFloat(window.getComputedStyle(t).opacity || '0'));
        return { hasCalmClass, avgOpacity: opacities.reduce((a, b) => a + b, 0) / opacities.length };
      })()
    `);
    console.log('Modo Calma Mobile en producción:', calmMobile);
    report.calmMobile = calmMobile;
    await cdp.screenshot('prod_mobile_modo_calma.png');
    await cdp.evaluate(`document.querySelector('textarea').blur();`);
    await sleep(600);

    // ─────────────────────────────────────────────────────────────
    // 5. OBSERVACIÓN DESKTOP 1440×900 EN PRODUCCIÓN (30s)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 5. OBSERVACIÓN DESKTOP 1440×900 EN PRODUCCIÓN (30s) ---');
    await cdp.setViewport(1440, 900, false);
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/preview/home-gsap` });
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
              if (collides(rect, h1) || collides(rect, textarea) || collides(rect, cta)) {
                functionalCollisions++;
              }
              for (const ch of chips) {
                if (collides(rect, ch)) functionalCollisions++;
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
            hasOverflow: document.documentElement.scrollWidth > window.innerWidth
          };
        })()
      `);

      report.desktopMetrics.push(dState);
      console.log(`Desktop t=${tSec}s: ${dState.visibleCount} tags (L: ${dState.largeCount}, M: ${dState.mediumCount}, S: ${dState.smallCount}), FuncCol=${dState.functionalCollisions}, PhraseCol=${dState.phraseCollisions}, Overflow=${dState.hasOverflow}`);

      if ([0, 15, 30].includes(tSec)) {
        await cdp.screenshot(`prod_desktop_1440x900_t${tSec}s.png`);
      }
    }

    // Modo Calma Desktop
    console.log('\n--- MODO CALMA DESKTOP ---');
    await cdp.evaluate(`document.querySelector('textarea').focus();`);
    await sleep(900);
    await cdp.screenshot('prod_desktop_modo_calma.png');
    await cdp.evaluate(`document.querySelector('textarea').blur();`);
    await sleep(600);

    // Reduced Motion Desktop
    console.log('\n--- REDUCED MOTION DESKTOP ---');
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2000);
    await cdp.screenshot('prod_desktop_reduced_motion.png');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    // ─────────────────────────────────────────────────────────────
    // 6. CONSISTENCIA F5 vs CTRL+F5 EN PRODUCCIÓN
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 6. CONSISTENCIA F5 vs CTRL+F5 EN PRODUCCIÓN ---');
    await cdp.send('Page.navigate', { url: `${PROD_BASE}/preview/home-gsap` });
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

    const isF5Consistent = JSON.stringify(f5Styles) === JSON.stringify(ctrlF5Styles);
    report.f5Consistency = { f5Styles, ctrlF5Styles, isF5Consistent };
    console.log('F5 Styles:', JSON.stringify(f5Styles));
    console.log('Ctrl+F5 Styles:', JSON.stringify(ctrlF5Styles));
    console.log('¿Consistencia F5 vs Ctrl+F5 100% idéntica?:', isF5Consistent ? 'SÍ (PASS)' : 'NO (FAIL)');

    fs.writeFileSync(
      path.join(screenshotDir, 'production_validation_report.json'),
      JSON.stringify(report, null, 2)
    );
    console.log('\nValidación completa finalizada. Reporte guardado con éxito.');

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
  }
}

run().catch((err) => {
  console.error('Error fatal en validación de producción:', err);
  process.exit(1);
});
