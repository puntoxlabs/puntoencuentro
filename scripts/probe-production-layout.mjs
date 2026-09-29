import { spawn } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';

const PROD_BASE = 'https://puntoencuentro.com.ar';
const CDP_PORT = 9230;

function getChromePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of possiblePaths) {
    if (possiblePaths) return p;
  }
  throw new Error('Chrome no encontrado');
}

async function probe() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'probe-geo-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${PROD_BASE}/preview/home-gsap`, { method: 'PUT' });
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
    // Emular un móvil Android típico: 360 x 780 o 390 x 844
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });
    
    // Autorizar
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });
    await send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 3000));

    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const heroWrapper = document.querySelector('.home-hero-wrapper');
        const heroWrapperRect = heroWrapper?.getBoundingClientRect();
        const canvas = document.querySelector('.home-dynamic-canvas--gsap');
        const canvasRect = canvas?.getBoundingClientRect();
        const eyebrow = document.querySelector('.home-hero-badge');
        const eyebrowRect = eyebrow?.getBoundingClientRect();
        const h1 = document.querySelector('.home-hero-title');
        const h1Rect = h1?.getBoundingClientRect();
        const phrase = document.querySelector('.home-hero-rotating-container');
        const phraseRect = phrase?.getBoundingClientRect();
        const photoLeft = document.querySelector('.home-gsap-mobile-frag--left');
        const photoLeftRect = photoLeft?.getBoundingClientRect();
        const photoRight = document.querySelector('.home-gsap-mobile-frag--right');
        const photoRightRect = photoRight?.getBoundingClientRect();
        const textarea = document.querySelector('textarea');
        const textareaRect = textarea?.getBoundingClientRect();
        const cta = document.querySelector('.home-intent-submit-btn, button[type="submit"]');
        const ctaRect = cta?.getBoundingClientRect();
        const chips = document.querySelector('.home-suggestion-chips');
        const chipsRect = chips?.getBoundingClientRect();
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => ({
          id: t.id,
          text: t.textContent.trim(),
          rect: t.getBoundingClientRect(),
          opacity: window.getComputedStyle(t).opacity,
          visibility: window.getComputedStyle(t).visibility,
          transform: window.getComputedStyle(t).transform,
        }));

        function collides(r1, r2) {
          if (!r1 || !r2) return false;
          return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
        }

        return {
          windowInner: { w: window.innerWidth, h: window.innerHeight },
          visualViewport: window.visualViewport ? { w: window.visualViewport.width, h: window.visualViewport.height, top: window.visualViewport.offsetTop } : null,
          heroWrapperRect,
          canvasRect,
          photoLeftRect,
          photoRightRect,
          eyebrowRect,
          h1Rect,
          phraseRect,
          textareaRect,
          ctaRect,
          chipsRect,
          colPhotoLeftH1: collides(photoLeftRect, h1Rect),
          colPhotoLeftEyebrow: collides(photoLeftRect, eyebrowRect),
          colPhotoRightH1: collides(photoRightRect, h1Rect),
          colPhotoRightEyebrow: collides(photoRightRect, eyebrowRect),
          tags
        };
      })()`,
      returnByValue: true
    });

    console.log(JSON.stringify(result.result?.value, null, 2));

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

probe().catch(console.error);
