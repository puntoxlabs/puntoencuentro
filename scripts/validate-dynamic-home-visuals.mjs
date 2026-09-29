import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const distDir = path.resolve('dist');
const screenshotDir = path.resolve('C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/dynamic-home-screenshots');

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
  const PORT = 4176;
  const CDP_PORT = 9226;

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Servidor local activo en http://127.0.0.1:${PORT}`);

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDir = path.join('C:\\Users\\Minar\\AppData\\Local\\Temp', 'chrome-dynamic-qa-' + Date.now());
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
          const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/?variant=a`, { method: 'PUT' });
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

      // Esperar a que la página cargue el documento inicial con origen http://127.0.0.1
      await new Promise((r) => setTimeout(r, 1500));

      // Pasar AccessGate de forma segura
      await cdp.evaluate(`
        try {
          localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
          localStorage.setItem('puntoencuentro_home_variant', 'envolvente');
        } catch (e) {
          console.error('Error al inicializar localStorage:', e);
        }
      `);

      // ─────────────────────────────────────────────────────────────
      // 1. VARIANTE A — MOVIMIENTO ENVOLVENTE
      // ─────────────────────────────────────────────────────────────
      console.log('Evaluando Variante A (Movimiento Envolvente)...');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?variant=a` });
      await new Promise((r) => setTimeout(r, 1500));

      // 1.A Desktop 1440x900 (t=0s)
      await cdp.setViewport(1440, 900);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('01_var_a_desktop_1440x900_t0.png');

      // 1.B Desktop 1440x900 tras 4 segundos de movimiento continuo (t=4s)
      await new Promise((r) => setTimeout(r, 4000));
      await cdp.screenshot('02_var_a_desktop_1440x900_t4s.png');

      // 1.C Mobile 390x844 (iPhone)
      await cdp.setViewport(390, 844);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('03_var_a_mobile_390x844_t0.png');

      // 1.D Mobile 390x844 tras 4 segundos de movimiento
      await new Promise((r) => setTimeout(r, 4000));
      await cdp.screenshot('04_var_a_mobile_390x844_t4s.png');

      // 1.E Mobile 360x800
      await cdp.setViewport(360, 800);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('05_var_a_mobile_360x800.png');

      // 1.F Mobile 430x932
      await cdp.setViewport(430, 932);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('06_var_a_mobile_430x932.png');

      // 1.G Simulación de Teclado / Foco en Input
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, 'Asado con amigos este sábado');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('07_var_a_mobile_keyboard_focus.png');

      // ─────────────────────────────────────────────────────────────
      // 2. VARIANTE B — VISOR DINÁMICO
      // ─────────────────────────────────────────────────────────────
      console.log('Evaluando Variante B (Visor Dinámico)...');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?variant=b` });
      await new Promise((r) => setTimeout(r, 1200));

      // 2.A Desktop 1440x900 (t=0s)
      await cdp.setViewport(1440, 900);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('08_var_b_desktop_1440x900_t0.png');

      // 2.B Desktop 1440x900 tras 4 segundos de cruces de etiquetas
      await new Promise((r) => setTimeout(r, 4000));
      await cdp.screenshot('09_var_b_desktop_1440x900_t4s.png');

      // 2.C Mobile 390x844
      await cdp.setViewport(390, 844);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('10_var_b_mobile_390x844.png');

      // ─────────────────────────────────────────────────────────────
      // 3. VARIANTE C — ESPACIO VIVO REFINADO
      // ─────────────────────────────────────────────────────────────
      console.log('Evaluando Variante C (Espacio Vivo Refinado)...');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?variant=c` });
      await new Promise((r) => setTimeout(r, 1200));

      // 3.A Desktop 1440x900 (t=0s)
      await cdp.setViewport(1440, 900);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('11_var_c_desktop_1440x900_t0.png');

      // 3.B Desktop 1440x900 tras 4 segundos (t=4s)
      await new Promise((r) => setTimeout(r, 4000));
      await cdp.screenshot('12_var_c_desktop_1440x900_t4s.png');

      // 3.C Desktop 1440x900 tras 10 segundos de coreografía (t=10s)
      await new Promise((r) => setTimeout(r, 6000));
      await cdp.screenshot('13_var_c_desktop_1440x900_t10s.png');

      // 3.D Mobile 390x844 (t=0s)
      await cdp.setViewport(390, 844);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.screenshot('14_var_c_mobile_390x844_t0.png');

      // 3.E Mobile 390x844 tras 4 segundos (t=4s)
      await new Promise((r) => setTimeout(r, 4000));
      await cdp.screenshot('15_var_c_mobile_390x844_t4s.png');

      // 3.F Mobile 360x800 (pantalla angosta)
      await cdp.setViewport(360, 800);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('16_var_c_mobile_360x800.png');

      // 3.G Mobile 430x932 (pantalla ancha Max/Plus)
      await cdp.setViewport(430, 932);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('17_var_c_mobile_430x932.png');

      // 3.H Mobile con foco en input (El mundo se calma mientras escribo)
      await cdp.evaluate(`
        const ta = document.querySelector('.home-intent-textarea');
        if (ta) {
          ta.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, 'Asado y pádel este sábado');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await new Promise((r) => setTimeout(r, 500));
      await cdp.screenshot('18_var_c_mobile_keyboard_focus.png');

      // Evaluar métricas DOM
      const evalMetrics = await cdp.evaluate(`
        (() => {
          const tags = document.querySelectorAll('.home-floating-tag--refinado');
          const ghostTags = document.querySelectorAll('.home-floating-tag--ghost');
          const photoMoments = document.querySelectorAll('.home-refinado-photo-momento');
          const mobilePeeks = document.querySelectorAll('.home-refinado-mobile-peek');
          const h1 = document.querySelector('.home-hero-title')?.textContent?.trim();
          const switcher = document.querySelector('.home-variant-floating-bar') !== null;
          const switcherActiveC = document.querySelector('.home-variant-btn--c.is-active') !== null;
          return {
            refinadoTagsCount: tags.length,
            ghostTagsCount: ghostTags.length,
            photoMomentsDesktopCount: photoMoments.length,
            mobilePeeksCount: mobilePeeks.length,
            h1Text: h1,
            switcherPresent: switcher,
            switcherActiveC: switcherActiveC
          };
        })()
      `);

      console.log('Métricas evaluadas en navegador real:', evalMetrics);
      fs.writeFileSync(
        path.join(screenshotDir, 'qa_evaluation_dynamic.json'),
        JSON.stringify(evalMetrics, null, 2)
      );

      console.log('Todas las validaciones visuales se completaron exitosamente.');
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
