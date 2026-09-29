import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 4197;
const CDP_PORT = 9225;
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
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
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
  close() {
    try { this.ws.close(); } catch(e) {}
  }
}

async function probe() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-probe-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/preview/home-gsap`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    cdp = new CdpClient(targetWs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    await cdp.evaluate(`localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`);

    // Probe Mobile 390x844
    await cdp.setViewport(390, 844, true);
    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 1500));

    const mobileRects = await cdp.evaluate(`
      (() => {
        const getR = sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(el => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        });
        return {
          header: getR('header'),
          badge: getR('.home-hero-badge'),
          h1: getR('.home-hero-title'),
          phrase: getR('.home-hero-rotating-container'),
          textarea: getR('textarea'),
          cta: getR('.home-intent-submit-btn, button[type="submit"]'),
          chips
        };
      })()
    `);
    console.log('--- MOBILE 390x844 FUNCTIONAL RECTS ---');
    console.log(JSON.stringify(mobileRects, null, 2));

    // Probe Desktop 1440x900
    await cdp.setViewport(1440, 900, false);
    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 1500));

    const desktopRects = await cdp.evaluate(`
      (() => {
        const getR = sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const chips = Array.from(document.querySelectorAll('.home-suggestion-chip')).map(el => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        });
        return {
          header: getR('header'),
          badge: getR('.home-hero-badge'),
          h1: getR('.home-hero-title'),
          phrase: getR('.home-hero-rotating-container'),
          textarea: getR('textarea'),
          cta: getR('.home-intent-submit-btn, button[type="submit"]'),
          chips
        };
      })()
    `);
    console.log('--- DESKTOP 1440x900 FUNCTIONAL RECTS ---');
    console.log(JSON.stringify(desktopRects, null, 2));

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
    server.close();
  }
}

probe().catch(console.error);
