import path from 'path';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import { WebSocket } from 'ws';

const CDP_PORT = 9245;
const DIST_DIR = path.resolve('dist');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || !path.extname(reqPath)) {
    reqPath = '/index.html';
  }
  const filePath = path.join(DIST_DIR, reqPath);
  if (!fs.existsSync(filePath)) {
    const indexPath = path.join(DIST_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(indexPath));
  }
  const ext = path.extname(filePath);
  const mimeMap = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
});

server.listen(4174, async () => {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-probe-' + Date.now());
  const proc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:4174/preview/home-gsap`, { method: 'PUT' });
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

    let reqId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = reqId++;
        const handler = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            ws.off('message', handler);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expr) {
      const res = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      return res.result?.value;
    }

    await send('Page.enable');
    await send('Runtime.enable');

    await evaluate(`localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`);

    const viewports = [
      { name: 'desktop_1366x768', width: 1366, height: 768 },
      { name: 'desktop_1440x900', width: 1440, height: 900 },
      { name: 'desktop_1920x1080', width: 1920, height: 1080 },
    ];

    for (const vp of viewports) {
      console.log(`\n=== Evaluando ${vp.name} ===`);
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: false,
      });

      await send('Page.navigate', { url: `http://127.0.0.1:4174/preview/home-gsap` });
      await new Promise(r => setTimeout(r, 800));

      // Muestrear a lo largo de 30 segundos (un loop completo es ~28s)
      for (let s = 0; s < 30; s++) {
        const result = await evaluate(`(() => {
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
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
          }
          function intersects(r1, r2) {
            if (!r1 || !r2) return false;
            return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
          }

          const h1R = getRect(h1);
          const badgeR = getRect(badge);
          const phraseR = getRect(phrase);
          const textareaR = getRect(textarea);
          const ctaR = getRect(cta);
          const chipsR = getRect(chips);
          const pillarsR = getRect(pillars);
          const fabR = getRect(fab);
          const previewBadgeR = getRect(previewBadge);

          const allTags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => {
            const cs = window.getComputedStyle(t);
            const op = parseFloat(cs.opacity || '0');
            const vis = cs.visibility !== 'hidden' && cs.display !== 'none' && op > 0.15;
            const r = getRect(t);
            const text = t.querySelector('.home-gsap-tag-text')?.textContent?.trim() || '';
            const id = t.id;

            const targets = { h1: h1R, badge: badgeR, phrase: phraseR, textarea: textareaR, cta: ctaR, chips: chipsR, pillars: pillarsR, fab: fabR, previewBadge: previewBadgeR };
            const collidedTargets = [];
            if (vis && r) {
              for (const [k, tgt] of Object.entries(targets)) {
                if (tgt && intersects(r, tgt)) collidedTargets.push(k);
              }
            }
            return { id, text, visible: vis, op, r, collidedTargets };
          });

          const visible = allTags.filter(t => t.visible);
          const collisions = allTags.filter(t => t.visible && t.collidedTargets.length > 0);

          return {
            visibleCount: visible.length,
            visibleIds: visible.map(t => t.id + '(' + t.op.toFixed(2) + ')'),
            collisions: collisions.map(t => ({ id: t.id, text: t.text, collidedWith: t.collidedTargets, r: t.r })),
          };
        })()`);

        if (result.visibleCount < 2 || result.collisions.length > 0) {
          console.log(`[t=${s}s] Visible count: ${result.visibleCount} [${result.visibleIds.join(', ')}]`);
          if (result.collisions.length > 0) {
            console.log(`   COLLISION:`, JSON.stringify(result.collisions));
          }
        }

        await new Promise(r => setTimeout(r, 1000));
      }
    }

    ws.close();
    proc.kill();
    server.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    proc.kill();
    server.close();
    process.exit(1);
  }
});
