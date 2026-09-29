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

server.listen(4177, async () => {
  const proc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--remote-debugging-port=9248', '--no-first-run', '--disable-gpu']);
  await new Promise(r => setTimeout(r, 1200));
  const resp = await fetch('http://127.0.0.1:9248/json/new?http://127.0.0.1:4177/preview/home-gsap', { method: 'PUT' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:4177/preview/home-gsap' });
  await new Promise(r => setTimeout(r, 1500));
  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.querySelector('#gt-pizza');
      const text = t.querySelector('.home-gsap-tag-text');
      const cs = window.getComputedStyle(t);
      const textCs = window.getComputedStyle(text);
      return {
        tagClientWidth: t.clientWidth,
        tagScrollWidth: t.scrollWidth,
        textClientWidth: text.clientWidth,
        textScrollWidth: text.scrollWidth,
        tagRect: t.getBoundingClientRect(),
        computedMaxWidth: cs.maxWidth,
        computedPadding: cs.padding,
        computedFontSize: cs.fontSize,
        textOverflow: textCs.textOverflow,
        textContent: text.textContent,
      };
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(res.result.value, null, 2));
  proc.kill();
  server.close();
  process.exit(0);
});
