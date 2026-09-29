import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || !path.extname(reqPath)) reqPath = '/index.html';
  const filePath = path.join(path.resolve('dist'), reqPath);
  res.writeHead(200, { 'Content-Type': path.extname(filePath) === '.js' ? 'application/javascript' : path.extname(filePath) === '.css' ? 'text/css' : 'text/html' });
  res.end(fs.readFileSync(fs.existsSync(filePath) ? filePath : path.join(path.resolve('dist'), 'index.html')));
});

server.listen(4176, async () => {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9247', '--no-first-run', '--disable-gpu']);
  await new Promise(r => setTimeout(r, 1200));
  const resp = await fetch('http://127.0.0.1:9247/json/new?http://127.0.0.1:4176/preview/home-gsap', { method: 'PUT' });
  const tab = await resp.json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 1;
  const send = (m, p = {}) => new Promise((res, rej) => {
    const cur = id++;
    const h = (d) => { const msg = JSON.parse(d.toString()); if (msg.id === cur) { ws.off('message', h); if (msg.error) rej(msg.error); else res(msg.result); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: cur, method: m, params: p }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));` });

  for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:4176/preview/home-gsap' });
    await new Promise(r => setTimeout(r, 1200));
    const rects = await send('Runtime.evaluate', {
      expression: `(() => {
        const get = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
        return {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          h1: get('.home-hero-title'),
          badge: get('.home-hero-badge'),
          phrase: get('.home-hero-rotating-container'),
          textarea: get('.home-intent-textarea'),
          cta: get('.home-intent-submit-btn'),
          chips: get('.home-suggestions-container'),
          pillars: get('.home-pillars-section'),
          photoLeft: get('.home-gsap-photo--left'),
          photoRightTop: get('.home-gsap-photo--right-top'),
          photoRightBottom: get('.home-gsap-photo--right-bottom'),
        };
      })()`,
      returnByValue: true
    });
    console.log(JSON.stringify(rects.result.value, null, 2));
  }
  proc.kill();
  server.close();
  process.exit(0);
});
