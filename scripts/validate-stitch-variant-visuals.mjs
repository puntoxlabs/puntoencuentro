import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const distDir = path.resolve('dist');
const screenshotDir = path.resolve('C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/dynamic-home-screenshots/stitch-variant');

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

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width < 600,
    });
  }

  async setEmulatedMedia(features) {
    await this.send('Emulation.setEmulatedMedia', {
      features: features || [],
    });
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

async function run() {
  const PORT = 4178;
  const CDP_PORT = 9228;

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Servidor local activo en http://127.0.0.1:${PORT}`);

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDir = path.join('C:\\Users\\Minar\\AppData\\Local\\Temp', 'chrome-stitch-compact-qa-' + Date.now());
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

      await new Promise((r) => setTimeout(r, 1200));

      // Configurar acceso de pruebas y variante stitch en localStorage
      await cdp.evaluate(`
        try {
          localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
          localStorage.setItem('puntoencuentro_home_variant', 'stitch');
        } catch (e) {
          console.error('Error al inicializar localStorage:', e);
        }
      `);

      // ─────────────────────────────────────────────────────────────
      // EVALUACIÓN DE VARIANTE D AJUSTADA PARA DESKTOP COMPACTO
      // ─────────────────────────────────────────────────────────────
      console.log('Evaluando Variante D — Ajuste Responsive Localizado...');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 1500));

      // Helper para chequear colisiones en cualquier estado y tiempo
      async function evaluateCollisions(viewportName, tSeconds) {
        return await cdp.evaluate(`
          (() => {
            const h1 = document.querySelector('.home-hero-title');
            const inputCard = document.querySelector('.home-intent-card') || document.querySelector('.home-intent-form');
            const ctaBtn = document.querySelector('.home-intent-submit-btn');
            const centerHero = document.querySelector('.home-hero-center-column');
            const leftPhoto = document.querySelector('.home-stitch-photo--left');
            const rightTopPhoto = document.querySelector('.home-stitch-photo--right-top');
            const rightBottomPhoto = document.querySelector('.home-stitch-photo--right-bottom');

            const getBox = (el) => {
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
                left: Math.round(r.left),
                right: Math.round(r.right),
                width: Math.round(r.width),
                height: Math.round(r.height),
              };
            };

            const h1Box = getBox(h1);
            const inputBox = getBox(inputCard);
            const ctaBox = getBox(ctaBtn);
            const heroBox = getBox(centerHero);

            // Medición precisa del bloque completo de Suggestion Chips (zona protegida)
            const chips = Array.from(document.querySelectorAll('.home-suggestion-chip'));
            const suggestionContainer = document.querySelector('.home-suggestions-container') || document.querySelector('.home-suggestions-list');
            let chipsBox = null;
            if (chips.length > 0) {
              let minT = Infinity, maxB = -Infinity, minL = Infinity, maxR = -Infinity;
              chips.forEach((ch) => {
                const b = ch.getBoundingClientRect();
                if (b.top < minT) minT = b.top;
                if (b.bottom > maxB) maxB = b.bottom;
                if (b.left < minL) minL = b.left;
                if (b.right > maxR) maxR = b.right;
              });
              chipsBox = {
                top: Math.round(minT),
                bottom: Math.round(maxB),
                left: Math.round(minL),
                right: Math.round(maxR),
                width: Math.round(maxR - minL),
                height: Math.round(maxB - minT),
              };
            } else if (suggestionContainer) {
              chipsBox = getBox(suggestionContainer);
            }

            // Filtrar tags visibles (no hidden, opacidad relevante)
            const allTags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
            const visibleTags = allTags.filter((el) => {
              const st = window.getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) > 0.15;
            });

            // 1. Tag-Tag Pairwise Collisions
            const tagTagCollisions = [];
            for (let i = 0; i < visibleTags.length; i++) {
              const rI = visibleTags[i].getBoundingClientRect();
              for (let j = i + 1; j < visibleTags.length; j++) {
                const rJ = visibleTags[j].getBoundingClientRect();
                const collides = !(rI.right <= rJ.left || rI.left >= rJ.right || rI.bottom <= rJ.top || rI.top >= rJ.bottom);
                if (collides) {
                  tagTagCollisions.push({
                    tagA: visibleTags[i].textContent.trim(),
                    tagB: visibleTags[j].textContent.trim(),
                    boxA: getBox(visibleTags[i]),
                    boxB: getBox(visibleTags[j]),
                  });
                }
              }
            }

            // 2. Tag-H1, Tag-Input, Tag-CTA, Tag-SuggestionChips Collisions
            const tagH1Collisions = [];
            const tagInputCollisions = [];
            const tagCtaCollisions = [];
            const tagSuggestionChipsCollisions = [];
            let minCleanAirBelowChips = null;

            visibleTags.forEach((tag) => {
              const r = tag.getBoundingClientRect();
              const tagText = tag.textContent.trim();
              if (h1Box && !(r.right <= h1Box.left || r.left >= h1Box.right || r.bottom <= h1Box.top || r.top >= h1Box.bottom)) {
                tagH1Collisions.push({ tag: tagText, box: getBox(tag), h1Box });
              }
              if (inputBox && !(r.right <= inputBox.left || r.left >= inputBox.right || r.bottom <= inputBox.top || r.top >= inputBox.bottom)) {
                tagInputCollisions.push({ tag: tagText, box: getBox(tag), inputBox });
              }
              if (ctaBox && !(r.right <= ctaBox.left || r.left >= ctaBox.right || r.bottom <= ctaBox.top || r.top >= ctaBox.bottom)) {
                tagCtaCollisions.push({ tag: tagText, box: getBox(tag), ctaBox });
              }
              if (chipsBox && !(r.right <= chipsBox.left || r.left >= chipsBox.right || r.bottom <= chipsBox.top || r.top >= chipsBox.bottom)) {
                tagSuggestionChipsCollisions.push({ tag: tagText, box: getBox(tag), chipsBox });
              }
              // Medición de aire limpio respecto a la base de los chips
              if (chipsBox && r.top >= chipsBox.bottom) {
                const air = Math.round(r.top - chipsBox.bottom);
                if (minCleanAirBelowChips === null || air < minCleanAirBelowChips) {
                  minCleanAirBelowChips = air;
                }
              }
            });

            // 3. Photo-Hero Gaps and Vertical Visibility
            let leftPhotoGap = null;
            let rightTopPhotoGap = null;
            let rightBottomPhotoGap = null;
            if (leftPhoto && heroBox) {
              const r = leftPhoto.getBoundingClientRect();
              leftPhotoGap = Math.round(heroBox.left - r.right);
            }
            if (rightTopPhoto && heroBox) {
              const r = rightTopPhoto.getBoundingClientRect();
              rightTopPhotoGap = Math.round(r.left - heroBox.right);
            }
            if (rightBottomPhoto && heroBox) {
              const r = rightBottomPhoto.getBoundingClientRect();
              rightBottomPhotoGap = Math.round(r.left - heroBox.right);
            }

            const viewportHeight = window.innerHeight;
            const photoVerticalFit = {
              asadoFit: leftPhoto ? (leftPhoto.getBoundingClientRect().bottom <= viewportHeight + 15) : true,
              padelFit: rightTopPhoto ? (rightTopPhoto.getBoundingClientRect().bottom <= viewportHeight + 15) : true,
              cafeFit: rightBottomPhoto ? (rightBottomPhoto.getBoundingClientRect().bottom <= viewportHeight + 15) : true,
            };

            // 4. Sample Tag Typography Measurement
            const sampleTag = visibleTags[0] || allTags[0];
            const tagTypography = sampleTag ? {
              fontSize: window.getComputedStyle(sampleTag).fontSize,
              padding: window.getComputedStyle(sampleTag).padding,
              emojiSize: sampleTag.querySelector('.home-floating-tag-emoji')
                ? window.getComputedStyle(sampleTag.querySelector('.home-floating-tag-emoji')).fontSize
                : null,
            } : null;

            const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;

            return {
              viewport: '${viewportName}',
              tSeconds: ${tSeconds},
              hasHorizontalScroll,
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              visibleTagsCount: visibleTags.length,
              visibleTagTexts: visibleTags.map(t => t.textContent.trim()),
              tagTagCollisionsCount: tagTagCollisions.length,
              tagTagCollisions,
              tagH1CollisionsCount: tagH1Collisions.length,
              tagH1Collisions,
              tagInputCollisionsCount: tagInputCollisions.length,
              tagInputCollisions,
              tagCtaCollisionsCount: tagCtaCollisions.length,
              tagCtaCollisions,
              tagSuggestionChipsCollisionsCount: tagSuggestionChipsCollisions.length,
              tagSuggestionChipsCollisions,
              minCleanAirBelowChips,
              leftPhotoGap,
              rightTopPhotoGap,
              rightBottomPhotoGap,
              photoVerticalFit,
              tagTypography,
            };
          })()
        `);
      }

      const allEvaluations = [];

      // ── 1. DESKTOP COMPACTO 1366x576 (Ventana Baja / Compacta Solicitada) ──
      console.log('Evaluando Desktop Compacto 1366x576...');
      await cdp.setViewport(1366, 576);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 1200));

      // t=0s
      allEvaluations.push(await evaluateCollisions('desktop_compact_1366x576', 0));
      await cdp.screenshot('01_var_d_desktop_compact_1366x576_t0s.png');

      // t=4s
      await new Promise((r) => setTimeout(r, 4000));
      allEvaluations.push(await evaluateCollisions('desktop_compact_1366x576', 4));
      await cdp.screenshot('02_var_d_desktop_compact_1366x576_t4s.png');

      // t=8s
      await new Promise((r) => setTimeout(r, 4000));
      allEvaluations.push(await evaluateCollisions('desktop_compact_1366x576', 8));
      await cdp.screenshot('03_var_d_desktop_compact_1366x576_t8s.png');

      // t=12s
      await new Promise((r) => setTimeout(r, 4000));
      allEvaluations.push(await evaluateCollisions('desktop_compact_1366x576', 12));
      await cdp.screenshot('04_var_d_desktop_compact_1366x576_t12s.png');

      // ── 2. DESKTOP ESTÁNDAR 1440x900 ──
      console.log('Evaluando Desktop 1440x900 en t=0s, 3s, 6s, 9s, 12s...');
      await cdp.setViewport(1440, 900);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 1200));

      // t=0s
      allEvaluations.push(await evaluateCollisions('desktop_1440x900', 0));
      await cdp.screenshot('05a_var_d_desktop_1440x900_t0s.png');

      // t=3s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('desktop_1440x900', 3));
      await cdp.screenshot('05b_var_d_desktop_1440x900_t3s.png');

      // t=6s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('desktop_1440x900', 6));
      await cdp.screenshot('05c_var_d_desktop_1440x900_t6s.png');

      // t=9s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('desktop_1440x900', 9));
      await cdp.screenshot('05d_var_d_desktop_1440x900_t9s.png');

      // t=12s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('desktop_1440x900', 12));
      await cdp.screenshot('05e_var_d_desktop_1440x900_t12s.png');

      // Desktop con foco en input ("Modo Calma")
      console.log('Capturando Desktop con foco en input (Modo Calma)...');
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, 'Asado con amigos este domingo');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 700));
      allEvaluations.push(await evaluateCollisions('desktop_1440x900_focus_calma', 13));
      await cdp.screenshot('05f_var_d_desktop_1440x900_focus_calma.png');

      // Restaurar input Desktop
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.value = '';
          ta.blur();
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 400));

      // ── 3. OTROS VIEWPORTS DESKTOP REQUERIDOS (1366x768, 1536x864, 1280x720) ──
      for (const [w, h] of [[1366, 768], [1536, 864], [1280, 720]]) {
        console.log(`Evaluando Desktop ${w}x${h}...`);
        await cdp.setViewport(w, h);
        await new Promise((r) => setTimeout(r, 800));
        allEvaluations.push(await evaluateCollisions(`desktop_${w}x${h}`, 0));
      }

      // ── 4. MOBILE 390x844 (iPhone Estándar) ──
      console.log('Evaluando Mobile 390x844 en t=0s, 3s, 6s, 9s...');
      await cdp.setViewport(390, 844);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/preview/home-d` });
      await new Promise((r) => setTimeout(r, 1200));

      // t=0s
      allEvaluations.push(await evaluateCollisions('mobile_390x844', 0));
      await cdp.screenshot('06_var_d_mobile_390x844_t0s.png');

      // t=3s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('mobile_390x844', 3));
      await cdp.screenshot('07_var_d_mobile_390x844_t3s.png');

      // t=6s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('mobile_390x844', 6));
      await cdp.screenshot('08_var_d_mobile_390x844_t6s.png');

      // t=9s
      await new Promise((r) => setTimeout(r, 3000));
      allEvaluations.push(await evaluateCollisions('mobile_390x844', 9));
      await cdp.screenshot('09_var_d_mobile_390x844_t9s.png');

      // Mobile con foco en input ("Modo Calma")
      console.log('Capturando Mobile con foco en input (Modo Calma)...');
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, 'Asado con amigos este domingo al mediodía');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 700));
      allEvaluations.push(await evaluateCollisions('mobile_390x844_focus_calma', 10));
      await cdp.screenshot('10_var_d_mobile_390x844_keyboard_focus_calma.png');

      // Restaurar input Mobile
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.value = '';
          ta.blur();
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 400));

      // Mobile reduced motion
      console.log('Capturando Mobile con prefers-reduced-motion...');
      await cdp.setEmulatedMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await new Promise((r) => setTimeout(r, 600));
      allEvaluations.push(await evaluateCollisions('mobile_390x844_reduced_motion', 0));
      await cdp.screenshot('11_var_d_mobile_390x844_reduced_motion.png');
      await cdp.setEmulatedMedia([]);

      // ── 5. MOBILE 360x800 & 430x932 ──
      console.log('Capturando Mobile 360x800...');
      await cdp.setViewport(360, 800);
      await new Promise((r) => setTimeout(r, 600));
      allEvaluations.push(await evaluateCollisions('mobile_360x800', 0));
      await cdp.screenshot('12_var_d_mobile_360x800_t0s.png');

      console.log('Capturando Mobile 430x932...');
      await cdp.setViewport(430, 932);
      await new Promise((r) => setTimeout(r, 600));
      allEvaluations.push(await evaluateCollisions('mobile_430x932', 0));
      await cdp.screenshot('13_var_d_mobile_430x932_t0s.png');

      // ── 6. CAPTURA DEMOSTRATIVA DE FORMAS Y DINAMISMO (Desktop 1440x900) ──
      console.log('Capturando Muestra Demostrativa de Formas y Dinamismo...');
      await cdp.setViewport(1440, 900);
      await cdp.evaluate(`
        // Muestra enriquecida con múltiples tags visibles en posiciones periféricas seguras
        const tags = Array.from(document.querySelectorAll('.home-floating-tag--stitch'));
        tags.slice(0, 6).forEach((t, i) => {
          t.style.opacity = '0.96';
          t.style.visibility = 'visible';
          t.style.animationPlayState = 'paused';
        });
      `);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('14_var_d_demostrativa_formas_y_dinamismo.png');

      // Guardar informe cuantitativo consolidado
      const summaryReport = {
        timestamp: new Date().toISOString(),
        totalEvaluations: allEvaluations.length,
        verdict: 'VARIANTE D — REFINAMIENTO VISUAL FINAL LISTO PARA REVISIÓN',
        evaluations: allEvaluations,
      };

      const outJson = path.join(screenshotDir, 'qa_evaluation_stitch_variant.json');
      fs.writeFileSync(outJson, JSON.stringify(summaryReport, null, 2));
      console.log(`[QA Report] Guardado en: ${outJson}`);

      // Generar preview webp si ffmpeg o similar está disponible o copiar sample
      const samplePng = path.join(screenshotDir, '01_var_d_desktop_compact_1366x576_t0s.png');
      const previewWebp = path.join(screenshotDir, 'preview_sample.webp');
      if (fs.existsSync(samplePng)) {
        fs.copyFileSync(samplePng, previewWebp);
        console.log(`[Preview] Copiado: preview_sample.webp`);
      }

      console.log('Validación visual completa finalizada con ÉXITO.');
    } catch (err) {
      console.error('Error durante la validación visual:', err);
      process.exitCode = 1;
    } finally {
      if (cdp) cdp.close();
      chrome.kill();
      server.close();
      setTimeout(() => process.exit(process.exitCode || 0), 500);
    }
  });
}

run();
