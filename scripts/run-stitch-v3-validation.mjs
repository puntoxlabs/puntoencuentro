import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const distDir = path.resolve('dist');
const screenshotDir = path.resolve('C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/stitch-v3-validation');

if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
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
    res.end('Server error: ' + err.message);
  }
});

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    };
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
    return outPath;
  }

  close() {
    this.ws.close();
  }
}

async function runValidationHarness() {
  const PORT = 4188;
  const CDP_PORT = 9233;

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Servidor local activo en http://127.0.0.1:${PORT}`);

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDir = path.join('C:\\Users\\Minar\\AppData\\Local\\Temp', 'chrome-stitch-v3-' + Date.now());
    const chrome = spawn(chromePath, [
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
          const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/preview/home-d`, { method: 'PUT' });
          if (resp.ok) {
            const tab = await resp.json();
            targetWs = tab.webSocketDebuggerUrl;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }

      if (!targetWs) throw new Error('No se pudo conectar a Chrome CDP');

      cdp = new CdpClient(targetWs);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 1500));

      // Inyectar autorización AccessGate
      await cdp.evaluate(`
        localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      `);

      // ─────────────────────────────────────────────────────────────
      // PARTE 1: VALIDACIÓN MOBILE (390×844) OBSERVACIÓN 30 SEGUNDOS
      // ─────────────────────────────────────────────────────────────
      console.log('\n===============================================================');
      console.log('1. VALIDACIÓN MOBILE PRINCIPAL (390×844) — OBSERVACIÓN 30s');
      console.log('===============================================================');
      await cdp.setViewport(390, 844, true);
      // Verificar panel de evaluación minimizado en mobile en la ruta principal (donde el switcher está activo)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await new Promise((r) => setTimeout(r, 1800));

      const mobileSwitcherCheck = await cdp.evaluate(`
        (() => {
          const minimizedBadge = document.querySelector('.home-variant-minimized-badge');
          const floatingBar = document.querySelector('.home-variant-floating-bar');
          return {
            hasMinimizedBadge: Boolean(minimizedBadge),
            hasFloatingBar: Boolean(floatingBar),
            badgeText: minimizedBadge?.textContent?.trim() || ''
          };
        })()
      `);
      console.log('Panel Switcher en mobile (/):', mobileSwitcherCheck);

      // Ahora navegar a /preview/home-d para la evaluación de Variante D Stitch
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 2000));

      const timestamps = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28];
      const mobileMetrics390 = [];

      for (let idx = 0; idx < timestamps.length; idx++) {
        const targetT = timestamps[idx];
        const waitMs = idx === 0 ? 0 : (timestamps[idx] - timestamps[idx - 1]) * 1000;
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const metrics = await cdp.evaluate(`
          (() => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
            const visibleTags = [];

            // Elementos funcionales a proteger de colisión (Safe Zone Completa)
            const eyebrow = document.querySelector('.home-hero-badge')?.getBoundingClientRect();
            const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
            const dynamicPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
            const textarea = document.querySelector('textarea')?.getBoundingClientRect();
            const ctaBtn = document.querySelector('.home-intent-submit-btn')?.getBoundingClientRect();
            const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(c => c.getBoundingClientRect());

            let collisionWithEyebrow = 0;
            let collisionsH1 = 0;
            let collisionWithDynamicPhrase = 0;
            let collisionsTextarea = 0;
            let collisionsCTA = 0;
            let collisionsChips = 0;

            for (const tag of tags) {
              const rect = tag.getBoundingClientRect();
              const cs = window.getComputedStyle(tag);
              const opacity = parseFloat(cs.opacity || '1');
              const display = cs.display;
              const visibility = cs.visibility;

              const inViewport = (
                rect.bottom > 0 &&
                rect.top < vh &&
                rect.right > 0 &&
                rect.left < vw
              );
              const isVis = inViewport && display !== 'none' && visibility !== 'hidden' && opacity > 0.05;

              if (isVis) {
                const text = tag.querySelector('.home-floating-tag-text')?.textContent || '';
                visibleTags.push({
                  text,
                  opacity: Math.round(opacity * 100) / 100,
                  rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) }
                });

                // Colisiones funcionales con Safe Zone Completa
                const overlaps = (b1, b2) => b1 && b2 && !(b1.right < b2.left || b1.left > b2.right || b1.bottom < b2.top || b1.top > b2.bottom);
                if (overlaps(rect, eyebrow)) collisionWithEyebrow++;
                if (overlaps(rect, h1)) collisionsH1++;
                if (overlaps(rect, dynamicPhrase)) collisionWithDynamicPhrase++;
                if (overlaps(rect, textarea)) collisionsTextarea++;
                if (overlaps(rect, ctaBtn)) collisionsCTA++;
                for (const chip of chips) {
                  if (overlaps(rect, chip)) collisionsChips++;
                }
              }
            }

            // Fotos visibles en mobile
            const frags = Array.from(document.querySelectorAll('.home-stitch-mobile-frag')).filter(f => {
              const r = f.getBoundingClientRect();
              return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && window.getComputedStyle(f).display !== 'none';
            });

            const scrollW = document.documentElement.scrollWidth;
            const clientW = document.documentElement.clientWidth;

            return {
              visibleTagsCount: visibleTags.length,
              visibleTags,
              visiblePhotosCount: frags.length,
              collisionWithEyebrow,
              collisionsH1,
              collisionWithDynamicPhrase,
              collisionsTextarea,
              collisionsCTA,
              collisionsChips,
              scrollW,
              clientW,
              hasHorizontalOverflow: scrollW > clientW
            };
          })()
        `);

        mobileMetrics390.push({ timeSec: targetT, ...metrics });
        console.log(`Mobile 390x844 t=${targetT}s: ${metrics.visibleTagsCount} tags visibles (${metrics.visibleTags.map(t => t.text).join(' + ')}), Fotos: ${metrics.visiblePhotosCount}, Colisiones: Phrase=${metrics.collisionWithDynamicPhrase} H1=${metrics.collisionsH1} TA=${metrics.collisionsTextarea} CTA=${metrics.collisionsCTA} Chips=${metrics.collisionsChips} Eyebrow=${metrics.collisionWithEyebrow}, Overflow=${metrics.hasHorizontalOverflow}`);

        // Capturas mobile solicitadas: t=0, t=4, t=8, t=12, t=20, t=28
        if ([0, 4, 8, 12, 20, 28].includes(targetT)) {
          await cdp.screenshot(`mobile_390x844_t${targetT}s.png`);
        }
      }

      // ─────────────────────────────────────────────────────────────
      // PARTE 2: TEST MODO CALMA (MOBILE)
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- TEST MODO CALMA (MOBILE 390×844) ---');
      await cdp.evaluate(`document.querySelector('textarea')?.focus()`);
      await new Promise((r) => setTimeout(r, 800));
      await cdp.screenshot(`mobile_390x844_modo_calma.png`);

      const mobileCalmCheck = await cdp.evaluate(`
        (() => {
          const canvas = document.querySelector('.home-dynamic-canvas');
          const hasCalmClass = canvas?.classList.contains('home-dynamic-canvas--input-focused');
          const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
          const opacities = tags.map(t => parseFloat(window.getComputedStyle(t).opacity));
          const avgOpacity = opacities.reduce((a, b) => a + b, 0) / opacities.length;
          const photoStage = document.querySelector('.home-stitch-mobile-stage');
          const photoOpacity = photoStage ? parseFloat(window.getComputedStyle(photoStage).opacity) : 1;

          document.querySelector('textarea')?.blur();

          return {
            hasCalmClass,
            avgOpacity: Math.round(avgOpacity * 100) / 100,
            photoOpacity: Math.round(photoOpacity * 100) / 100
          };
        })()
      `);
      console.log('Modo Calma Mobile resultado:', mobileCalmCheck);
      await new Promise((r) => setTimeout(r, 600));

      // ─────────────────────────────────────────────────────────────
      // PARTE 3: REDUCED MOTION (MOBILE)
      // ─────────────────────────────────────────────────────────────
      console.log('\n--- TEST REDUCED MOTION (MOBILE 390×844) ---');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot(`mobile_390x844_reduced_motion.png`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await new Promise((r) => setTimeout(r, 600));

      // ─────────────────────────────────────────────────────────────
      // PARTE 4: VALIDACIÓN EN OTROS VIEWPORTS MOBILE (360×800 y 430×932)
      // ─────────────────────────────────────────────────────────────
      console.log('\n===============================================================');
      console.log('2. VALIDACIÓN VIEWPORTS MOBILE ADICIONALES (360×800 y 430×932)');
      console.log('===============================================================');

      for (const vp of [{ w: 360, h: 800 }, { w: 430, h: 932 }]) {
        console.log(`Evaluando viewport ${vp.w}x${vp.h}...`);
        await cdp.setViewport(vp.w, vp.h, true);
        await new Promise((r) => setTimeout(r, 1000));

        let totalVis = 0;
        let samples = 0;
        let overflow = false;
        let anyCollision = 0;

        for (let t = 0; t <= 12; t += 3) {
          if (t > 0) await new Promise((r) => setTimeout(r, 3000));
          const check = await cdp.evaluate(`
            (() => {
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
              const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
              const phrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
              const ta = document.querySelector('textarea')?.getBoundingClientRect();
              let vis = 0;
              let col = 0;
              let colPhrase = 0;
              for (const tag of tags) {
                const r = tag.getBoundingClientRect();
                const cs = window.getComputedStyle(tag);
                const op = parseFloat(cs.opacity || '1');
                if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && cs.display !== 'none' && op > 0.05) {
                  vis++;
                  const overlaps = (b1, b2) => b1 && b2 && !(b1.right < b2.left || b1.left > b2.right || b1.bottom < b2.top || b1.top > b2.bottom);
                  if (overlaps(r, phrase)) colPhrase++;
                  if (overlaps(r, h1) || overlaps(r, ta)) col++;
                }
              }
              const scrollW = document.documentElement.scrollWidth;
              const clientW = document.documentElement.clientWidth;
              return { vis, col, colPhrase, hasOverflow: scrollW > clientW };
            })()
          `);
          totalVis += check.vis;
          samples++;
          if (check.hasOverflow) overflow = true;
          if (check.col > 0) anyCollision += check.col;
          if (check.colPhrase > 0) anyCollision += check.colPhrase;
        }

        const avg = Math.round((totalVis / samples) * 10) / 10;
        console.log(`Viewport ${vp.w}x${vp.h}: Promedio tags visibles=${avg}, Overflow=${overflow}, Colisiones=${anyCollision}`);
      }

      // ─────────────────────────────────────────────────────────────
      // PARTE 5: VALIDACIÓN DESKTOP (1440×900) OBSERVACIÓN 30 SEGUNDOS
      // ─────────────────────────────────────────────────────────────
      console.log('\n===============================================================');
      console.log('3. VALIDACIÓN DESKTOP (1440×900) — OBSERVACIÓN 30s');
      console.log('===============================================================');
      await cdp.setViewport(1440, 900, false);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 2000));

      // Jerarquía y morfologías
      const desktopStructure = await cdp.evaluate(`
        (() => {
          const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
          const sizes = { large: 0, medium: 0, small: 0 };
          const shapes = new Set();
          tags.forEach(t => {
            if (t.classList.contains('home-floating-tag--size-large')) sizes.large++;
            else if (t.classList.contains('home-floating-tag--size-small')) sizes.small++;
            else sizes.medium++;

            const m = t.className.match(/home-floating-tag--stitch-shape-([a-z0-9-]+)/);
            if (m) shapes.add(m[1]);
          });

          // Fotos desktop
          const photos = Array.from(document.querySelectorAll('.home-stitch-photo'));
          const photosInfo = photos.map(p => {
            const img = p.querySelector('img');
            const anim = window.getComputedStyle(p).animationName;
            return {
              className: p.className,
              animName: anim,
              loaded: img?.complete && img?.naturalWidth > 0
            };
          });

          return {
            totalTags: tags.length,
            sizesCount: sizes,
            shapes: Array.from(shapes),
            photosInfo
          };
        })()
      `);
      console.log('Estructura Desktop:', desktopStructure);

      const desktopTimestamps = [0, 5, 10, 15, 20, 25, 30];
      const desktopMetrics = [];

      for (let idx = 0; idx < desktopTimestamps.length; idx++) {
        const targetT = desktopTimestamps[idx];
        const waitMs = idx === 0 ? 0 : (desktopTimestamps[idx] - desktopTimestamps[idx - 1]) * 1000;
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const metrics = await cdp.evaluate(`
          (() => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
            const hero = document.querySelector('.home-hero-center-column')?.getBoundingClientRect();
            const eyebrow = document.querySelector('.home-hero-badge')?.getBoundingClientRect();
            const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
            const dynamicPhrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
            const ta = document.querySelector('textarea')?.getBoundingClientRect();
            const cta = document.querySelector('.home-intent-submit-btn')?.getBoundingClientRect();
            const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(c => c.getBoundingClientRect());

            let visibleCount = 0;
            let largeCount = 0;
            let mediumCount = 0;
            let smallCount = 0;
            let functionalCollisions = 0;
            let collisionWithDynamicPhrase = 0;
            let collisionWithEyebrow = 0;
            let tagCollisions = 0;
            let minDistanceToSafeZone = 9999;

            const visibleBoxes = [];

            for (const tag of tags) {
              const r = tag.getBoundingClientRect();
              const cs = window.getComputedStyle(tag);
              const op = parseFloat(cs.opacity || '1');
              if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && cs.display !== 'none' && op > 0.05) {
                visibleCount++;
                if (tag.classList.contains('home-floating-tag--size-large')) largeCount++;
                else if (tag.classList.contains('home-floating-tag--size-small')) smallCount++;
                else mediumCount++;

                visibleBoxes.push(r);

                // Colisiones con controles críticos
                const overlaps = (b1, b2) => b1 && b2 && !(b1.right < b2.left || b1.left > b2.right || b1.bottom < b2.top || b1.top > b2.bottom);
                if (overlaps(r, dynamicPhrase)) collisionWithDynamicPhrase++;
                if (overlaps(r, eyebrow)) collisionWithEyebrow++;
                if (overlaps(r, h1) || overlaps(r, ta) || overlaps(r, cta)) {
                  functionalCollisions++;
                }

                // Distancia horizontal a la columna central (safe zone)
                if (ta) {
                  const distLeft = ta.left - r.right;
                  const distRight = r.left - ta.right;
                  const dist = Math.max(0, Math.min(distLeft > 0 ? distLeft : 9999, distRight > 0 ? distRight : 9999));
                  if (dist < minDistanceToSafeZone) minDistanceToSafeZone = dist;
                }
              }
            }

            // Colisiones tag-tag
            for (let i = 0; i < visibleBoxes.length; i++) {
              for (let j = i + 1; j < visibleBoxes.length; j++) {
                const b1 = visibleBoxes[i];
                const b2 = visibleBoxes[j];
                const overlap = !(b1.right < b2.left || b1.left > b2.right || b1.bottom < b2.top || b1.top > b2.bottom);
                if (overlap) tagCollisions++;
              }
            }

            const scrollW = document.documentElement.scrollWidth;
            const clientW = document.documentElement.clientWidth;

            return {
              visibleCount,
              largeCount,
              mediumCount,
              smallCount,
              collisionWithDynamicPhrase,
              collisionWithEyebrow,
              functionalCollisions,
              tagCollisions,
              minDistanceToSafeZone: Math.round(minDistanceToSafeZone),
              hasOverflow: scrollW > clientW
            };
          })()
        `);

        desktopMetrics.push({ timeSec: targetT, ...metrics });
        console.log(`Desktop 1440x900 t=${targetT}s: ${metrics.visibleCount} tags visibles (Large: ${metrics.largeCount}, Med: ${metrics.mediumCount}, Small: ${metrics.smallCount}), Colisiones funcionales: ${metrics.functionalCollisions}, Phrase: ${metrics.collisionWithDynamicPhrase}, Tag-Tag: ${metrics.tagCollisions}, MinDistSafeZone: ${metrics.minDistanceToSafeZone}px, Overflow: ${metrics.hasOverflow}`);

        // Capturas desktop solicitadas: t=0, t=5, t=10, t=20
        if ([0, 5, 10, 20].includes(targetT)) {
          await cdp.screenshot(`desktop_1440x900_t${targetT}s.png`);
        }
      }

      // Modo Calma Desktop
      console.log('\n--- TEST MODO CALMA (DESKTOP 1440×900) ---');
      await cdp.evaluate(`document.querySelector('textarea')?.focus()`);
      await new Promise((r) => setTimeout(r, 800));
      await cdp.screenshot(`desktop_1440x900_modo_calma.png`);
      await cdp.evaluate(`document.querySelector('textarea')?.blur()`);
      await new Promise((r) => setTimeout(r, 600));

      // Reduced Motion Desktop
      console.log('\n--- TEST REDUCED MOTION (DESKTOP 1440×900) ---');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot(`desktop_1440x900_reduced_motion.png`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await new Promise((r) => setTimeout(r, 600));

      // ─────────────────────────────────────────────────────────────
      // PARTE 6: VALIDACIÓN OTROS VIEWPORTS DESKTOP (1366×768 y 1920×1080)
      // ─────────────────────────────────────────────────────────────
      console.log('\n===============================================================');
      console.log('4. VALIDACIÓN VIEWPORTS DESKTOP ADICIONALES (1366×768 y 1920×1080)');
      console.log('===============================================================');

      for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
        console.log(`Evaluando desktop ${vp.w}x${vp.h}...`);
        await cdp.setViewport(vp.w, vp.h, false);
        await new Promise((r) => setTimeout(r, 1000));

        let totalVis = 0;
        let samples = 0;
        let overflow = false;
        let colFunc = 0;

        for (let t = 0; t <= 10; t += 5) {
          if (t > 0) await new Promise((r) => setTimeout(r, 5000));
          const check = await cdp.evaluate(`
            (() => {
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
              const h1 = document.querySelector('.home-hero-title')?.getBoundingClientRect();
              const ta = document.querySelector('textarea')?.getBoundingClientRect();
              const cta = document.querySelector('.home-intent-submit-btn')?.getBoundingClientRect();
              const phrase = document.querySelector('.home-hero-rotating-container')?.getBoundingClientRect();
              let vis = 0;
              let col = 0;
              let colPhrase = 0;
              const colDetails = [];
              for (const tag of tags) {
                const r = tag.getBoundingClientRect();
                const cs = window.getComputedStyle(tag);
                const op = parseFloat(cs.opacity || '1');
                if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && cs.display !== 'none' && op > 0.05) {
                  vis++;
                  const overlaps = (b1, b2) => b1 && b2 && !(b1.right < b2.left || b1.left > b2.right || b1.bottom < b2.top || b1.top > b2.bottom);
                  if (overlaps(r, phrase)) colPhrase++;
                  if (overlaps(r, h1) || overlaps(r, ta) || overlaps(r, cta)) {
                    col++;
                    colDetails.push({
                      text: tag.querySelector('.home-floating-tag-text')?.textContent || '',
                      r: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
                      h1: h1 ? { top: Math.round(h1.top), bottom: Math.round(h1.bottom), left: Math.round(h1.left), right: Math.round(h1.right) } : null,
                      ta: ta ? { top: Math.round(ta.top), bottom: Math.round(ta.bottom), left: Math.round(ta.left), right: Math.round(ta.right) } : null
                    });
                  }
                }
              }
              const scrollW = document.documentElement.scrollWidth;
              const clientW = document.documentElement.clientWidth;
              return { vis, col, colPhrase, colDetails, hasOverflow: scrollW > clientW };
            })()
          `);
          totalVis += check.vis;
          samples++;
          if (check.hasOverflow) overflow = true;
          if (check.col > 0) {
            colFunc += check.col;
            console.log(`[Colisión detectada en ${vp.w}x${vp.h} t=${t}s]:`, JSON.stringify(check.colDetails));
          }
        }

        const avg = Math.round((totalVis / samples) * 10) / 10;
        console.log(`Viewport Desktop ${vp.w}x${vp.h}: Promedio tags visibles=${avg}, Overflow=${overflow}, Colisiones Func=${colFunc}`);
      }

      // ─────────────────────────────────────────────────────────────
      // PARTE 7: VALIDACIÓN DE CONSISTENCIA F5 vs Ctrl+F5
      // ─────────────────────────────────────────────────────────────
      console.log('\n===============================================================');
      console.log('5. TEST DE CONSISTENCIA F5 (Normal) vs Ctrl+F5 (Hard Reload)');
      console.log('===============================================================');
      await cdp.setViewport(1440, 900, false);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 1800));

      // F5 Normal
      await cdp.send('Page.reload', { ignoreCache: false });
      await new Promise((r) => setTimeout(r, 1800));
      const f5Styles = await cdp.evaluate(`
        (() => {
          const lTag = document.querySelector('.home-floating-tag--size-large');
          const mTag = document.querySelector('.home-floating-tag--size-medium');
          const sTag = document.querySelector('.home-floating-tag--size-small');
          return {
            large: { fontSize: lTag ? window.getComputedStyle(lTag).fontSize : '', padding: lTag ? window.getComputedStyle(lTag).padding : '' },
            medium: { fontSize: mTag ? window.getComputedStyle(mTag).fontSize : '', padding: mTag ? window.getComputedStyle(mTag).padding : '' },
            small: { fontSize: sTag ? window.getComputedStyle(sTag).fontSize : '', padding: sTag ? window.getComputedStyle(sTag).padding : '' }
          };
        })()
      `);

      // Ctrl+F5 Hard Reload
      await cdp.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 1800));
      const ctrlF5Styles = await cdp.evaluate(`
        (() => {
          const lTag = document.querySelector('.home-floating-tag--size-large');
          const mTag = document.querySelector('.home-floating-tag--size-medium');
          const sTag = document.querySelector('.home-floating-tag--size-small');
          return {
            large: { fontSize: lTag ? window.getComputedStyle(lTag).fontSize : '', padding: lTag ? window.getComputedStyle(lTag).padding : '' },
            medium: { fontSize: mTag ? window.getComputedStyle(mTag).fontSize : '', padding: mTag ? window.getComputedStyle(mTag).padding : '' },
            small: { fontSize: sTag ? window.getComputedStyle(sTag).fontSize : '', padding: sTag ? window.getComputedStyle(sTag).padding : '' }
          };
        })()
      `);

      const isConsistent = JSON.stringify(f5Styles) === JSON.stringify(ctrlF5Styles);
      console.log('F5 Styles (Normal):', JSON.stringify(f5Styles));
      console.log('Ctrl+F5 Styles (Hard Reload):', JSON.stringify(ctrlF5Styles));
      console.log('¿Consistencia F5 vs Ctrl+F5 100% idéntica?:', isConsistent ? 'SÍ (PASS)' : 'NO (FAIL)');

      // ─────────────────────────────────────────────────────────────
      // PARTE 8: VERIFICACIÓN SECCIÓN DE LANZAMIENTO (2 PILARES) EN PREVIEW
      // ─────────────────────────────────────────────────────────────
      const pillarsCheck = await cdp.evaluate(`
        (() => {
          const pillars = document.querySelectorAll('.home-pillar-card');
          const pillarTitles = Array.from(document.querySelectorAll('.home-pillar-title')).map(t => t.textContent.trim());
          const hasProximamente = Array.from(document.querySelectorAll('.home-pillar-badge')).some(b => b.textContent.includes('Próximamente'));
          const hasEncontrarConQuien = pillarTitles.some(t => t.includes('Encontrar con quién'));
          return {
            pillarsCount: pillars.length,
            pillarTitles,
            hasProximamente,
            hasEncontrarConQuien
          };
        })()
      `);
      console.log('\nSección Pilares en /preview/home-d (Esperado: 2 pilares, 0 Próximamente, 0 Encontrar con quién):', pillarsCheck);

      // ─────────────────────────────────────────────────────────────
      // PARTE 9: VERIFICACIÓN HOME PRINCIPAL INTACTA (/)
      // ─────────────────────────────────────────────────────────────
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await new Promise((r) => setTimeout(r, 1800));
      const homeRootCheck = await cdp.evaluate(`
        (() => {
          const pillars = document.querySelectorAll('.home-pillar-card');
          const pillarTitles = Array.from(document.querySelectorAll('.home-pillar-title')).map(t => t.textContent.trim());
          const hasProximamente = Array.from(document.querySelectorAll('.home-pillar-badge')).some(b => b.textContent.includes('Próximamente'));
          const stitchCanvas = document.querySelector('.home-dynamic-canvas--stitch');
          return {
            pillarsCount: pillars.length,
            pillarTitles,
            hasProximamente,
            hasStitchCanvas: Boolean(stitchCanvas)
          };
        })()
      `);
      console.log('\nHome Principal intacta (/):', homeRootCheck);

      // Guardar resultados completos en archivo JSON
      const fullReport = {
        timestamp: new Date().toISOString(),
        mobileSwitcherCheck,
        mobileMetrics390,
        mobileCalmCheck,
        desktopStructure,
        desktopMetrics,
        f5VsCtrlF5: { f5Styles, ctrlF5Styles, isConsistent },
        pillarsPreviewCheck: pillarsCheck,
        homeRootCheck
      };
      fs.writeFileSync(path.join(screenshotDir, 'validation_report.json'), JSON.stringify(fullReport, null, 2));
      console.log('\nReporte de validación guardado en validation_report.json');

    } finally {
      if (cdp) cdp.close();
      chrome.kill('SIGTERM');
      server.close();
    }
  });
}

runValidationHarness()
  .then(() => {
    console.log('Arnés de validación finalizado con éxito.');
  })
  .catch((err) => {
    console.error('Error durante ejecución del arnés:', err);
    process.exit(1);
  });
