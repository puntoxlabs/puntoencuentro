import { spawn } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';

const PROD_BASE = 'https://puntoencuentro.com.ar';
const CDP_PORT = 9234;

async function probe() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'probe-d-file-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${PROD_BASE}/preview/home-d`, { method: 'PUT' });
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
    
    await send('Page.navigate', { url: `${PROD_BASE}/preview/home-d` });
    await new Promise(r => setTimeout(r, 1500));

    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    await send('Page.reload');
    await new Promise(r => setTimeout(r, 3000));

    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const heroWrapper = document.querySelector('.home-hero-wrapper');
        const canvas = document.querySelector('.home-dynamic-canvas');
        const photoLeft = document.querySelector('.home-stitch-mobile-frag--left');
        const eyebrow = document.querySelector('.home-hero-badge');
        const h1 = document.querySelector('.home-hero-title');
        const chips = document.querySelector('.home-suggestion-chips');
        
        const tags = Array.from(document.querySelectorAll('.home-floating-tag')).map(t => ({
          text: t.textContent.trim(),
          classes: t.className,
          rect: t.getBoundingClientRect().toJSON(),
          opacity: window.getComputedStyle(t).opacity,
          vis: window.getComputedStyle(t).visibility,
          topStyle: window.getComputedStyle(t).top,
          bottomStyle: window.getComputedStyle(t).bottom,
          leftStyle: window.getComputedStyle(t).left,
          rightStyle: window.getComputedStyle(t).right,
        }));

        function collides(r1, r2) {
          if (!r1 || !r2) return false;
          return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
        }

        const pLRect = photoLeft ? photoLeft.getBoundingClientRect().toJSON() : null;
        const ebRect = eyebrow ? eyebrow.getBoundingClientRect().toJSON() : null;
        const h1Rect = h1 ? h1.getBoundingClientRect().toJSON() : null;

        return {
          heroWrapperPadding: heroWrapper ? window.getComputedStyle(heroWrapper).padding : null,
          heroWrapperRect: heroWrapper ? heroWrapper.getBoundingClientRect().toJSON() : null,
          canvasRect: canvas ? canvas.getBoundingClientRect().toJSON() : null,
          photoLeftRect: pLRect,
          eyebrowRect: ebRect,
          h1Rect: h1Rect,
          chipsRect: chips ? chips.getBoundingClientRect().toJSON() : null,
          colPhotoLeftEyebrow: collides(pLRect, ebRect),
          colPhotoLeftH1: collides(pLRect, h1Rect),
          visibleTags: tags.filter(t => parseFloat(t.opacity) > 0.05 && t.vis !== 'hidden')
        };
      })()`,
      returnByValue: true
    });

    console.log(JSON.stringify(res.result?.value, null, 2));

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

probe().catch(console.error);
