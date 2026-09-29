import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 4197;
const CDP_PORT = 9235;
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

async function testLocal() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'test-local-gsap-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
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
    if (!targetWs) throw new Error('No target ws');

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
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });

    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    await send('Page.reload');
    await new Promise(r => setTimeout(r, 2500));

    const data = await send('Runtime.evaluate', {
      expression: `(() => {
        const heroWrapper = document.querySelector('.home-hero-wrapper');
        const photoLeft = document.querySelector('.home-gsap-mobile-frag--left');
        const photoRight = document.querySelector('.home-gsap-mobile-frag--right');
        const eyebrow = document.querySelector('.home-hero-badge');
        const h1 = document.querySelector('.home-hero-title');
        const phrase = document.querySelector('.home-hero-rotating-container');
        const chips = document.querySelector('.home-suggestion-chips');

        function collides(r1, r2) {
          if (!r1 || !r2) return false;
          return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
        }

        const hwRect = heroWrapper ? heroWrapper.getBoundingClientRect().toJSON() : null;
        const pLRect = photoLeft ? photoLeft.getBoundingClientRect().toJSON() : null;
        const pRRect = photoRight ? photoRight.getBoundingClientRect().toJSON() : null;
        const ebRect = eyebrow ? eyebrow.getBoundingClientRect().toJSON() : null;
        const h1Rect = h1 ? h1.getBoundingClientRect().toJSON() : null;
        const phRect = phrase ? phrase.getBoundingClientRect().toJSON() : null;
        const chRect = chips ? chips.getBoundingClientRect().toJSON() : null;

        return {
          heroWrapperPadding: heroWrapper ? window.getComputedStyle(heroWrapper).padding : null,
          heroWrapperRect: hwRect,
          photoLeftRect: pLRect,
          photoRightRect: pRRect,
          eyebrowRect: ebRect,
          h1Rect: h1Rect,
          phraseRect: phRect,
          chipsRect: chRect,
          colPhotoLeftEyebrow: collides(pLRect, ebRect),
          colPhotoLeftH1: collides(pLRect, h1Rect),
          colPhotoLeftPhrase: collides(pLRect, phRect),
          colPhotoRightEyebrow: collides(pRRect, ebRect),
          colPhotoRightH1: collides(pRRect, h1Rect),
          colPhotoRightPhrase: collides(pRRect, phRect),
        };
      })()`,
      returnByValue: true
    });

    console.log(JSON.stringify(data.result?.value, null, 2));

    ws.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

testLocal().catch(console.error);
