import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const LOCAL_PORT = 4174;
const CDP_PORT = 9245;
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
    res.end('Error: ' + err.message);
  }
});

async function debugCollisions() {
  await new Promise(r => server.listen(LOCAL_PORT, '127.0.0.1', r));
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-col-debug-' + Date.now());
  const proc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars'
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${LOCAL_PORT}/preview/home-gsap`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
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

    // Autorizar AccessGate
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    const checkExpr = `(() => {
      const h1 = document.querySelector('.home-hero-title');
      const badge = document.querySelector('.home-hero-badge');
      const phrase = document.querySelector('.home-hero-rotating-container');
      const textarea = document.querySelector('.home-intent-textarea');
      const cta = document.querySelector('.home-intent-submit-btn');
      const chips = document.querySelector('.home-suggestions-container');
      const pillars = document.querySelector('.home-pillars-section');
      const fab = document.querySelector('.home-fab');
      const previewBadge = document.querySelector('button[title*="GSAP"], .home-gsap-preview-badge');

      function getRect(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      }

      function intersects(r1, r2) {
        if (!r1 || !r2) return false;
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      }

      const obstacles = {
        h1: getRect(h1),
        badge: getRect(badge),
        phrase: getRect(phrase),
        textarea: getRect(textarea),
        cta: getRect(cta),
        chips: getRect(chips),
        pillars: getRect(pillars),
        fab: getRect(fab),
        previewBadge: getRect(previewBadge),
      };

      const colliding = [];
      const allTags = Array.from(document.querySelectorAll('.home-gsap-tag'));
      for (const t of allTags) {
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity || '0');
        if (cs.visibility === 'hidden' || cs.display === 'none' || op < 0.15) continue;
        const r = getRect(t);
        if (!r) continue;

        for (const [name, obsR] of Object.entries(obstacles)) {
          if (obsR && intersects(r, obsR)) {
            colliding.push({
              tagId: t.id,
              text: t.querySelector('.home-gsap-tag-text')?.textContent,
              tagRect: r,
              collidedWith: name,
              obsRect: obsR,
            });
          }
        }
      }
      return { obstacles, colliding };
    })()`;

    // 1. Diagnosticar 360x800
    console.log('--- Diagnosticando 360x800 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 1200));

    for (let t = 0; t < 24; t++) {
      const res = (await send('Runtime.evaluate', { expression: checkExpr, returnByValue: true })).result.value;
      if (t === 0) {
        console.log('Obstacles 360x800:', JSON.stringify(res.obstacles, null, 2));
      }
      if (res.colliding.length > 0) {
        console.log(`[360x800 t=${t * 0.5}s] Colisión:`, JSON.stringify(res.colliding, null, 2));
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // 2. Diagnosticar Desktop 1440x900
    console.log('\n--- Diagnosticando Desktop 1440x900 ---');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 1200));

    for (let t = 0; t < 32; t++) {
      const res = (await send('Runtime.evaluate', { expression: checkExpr, returnByValue: true })).result.value;
      if (res.colliding.length > 0) {
        console.log(`[1440x900 t=${t * 0.5}s] Colisión:`, JSON.stringify(res.colliding, null, 2));
      }
      await new Promise(r => setTimeout(r, 500));
    }

    ws.close();
  } finally {
    proc.kill();
    server.close();
  }
}
debugCollisions().catch(console.error);
