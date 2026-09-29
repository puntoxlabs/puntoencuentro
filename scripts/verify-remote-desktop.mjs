import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

async function testDesktop() {
  const CDP_PORT = 9241;
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-prod-desk-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?https://puntoencuentro.com.ar/preview/home-gsap`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!targetWs) throw new Error('No target WS');

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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // Esperar primera carga en el dominio para autorizar localStorage
    await new Promise(r => setTimeout(r, 1000));
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-gsap' });
    await new Promise(r => setTimeout(r, 3500));

    const evalResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => ({
          id: t.id,
          classes: t.className,
          text: t.querySelector('.home-gsap-tag-text')?.textContent,
          count: t.querySelector('.home-gsap-tag-count')?.textContent,
          rect: t.getBoundingClientRect(),
          opacity: window.getComputedStyle(t).opacity,
          transform: window.getComputedStyle(t).transform
        }));
        const cta = document.querySelector('.home-hero-cta')?.getBoundingClientRect();
        return {
          totalTags: tags.length,
          visibleCount: tags.filter(t => parseFloat(t.opacity) > 0.2).length,
          tags,
          cta
        };
      })()`,
      returnByValue: true
    });

    console.log('Desktop 1440x900 on remote:', JSON.stringify(evalResult.result.value, null, 2));

    const artifactsDir = path.join('C:', 'Users', 'Minar', '.gemini', 'antigravity', 'brain', '70d9face-fb29-4084-a777-b0b51f8d52f3', 'production-gsap-validation');
    const ss1440 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'prod_desktop_1440x900_t3s.png'), Buffer.from(ss1440.data, 'base64'));
    console.log('Screenshot guardado en prod_desktop_1440x900_t3s.png');

    ws.close();
  } finally {
    proc.kill();
  }
}
testDesktop().catch(console.error);
